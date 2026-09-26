import amqp, { type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib';
import { request } from 'undici';
import { z } from 'zod';
import { openSecret, sign } from '@hookrelay/shared/crypto';
import { watchPartitions } from '@hookrelay/shared/partitions';
import {
  assertTopology, DEAD_QUEUE, MAX_ATTEMPTS, queueFor, retryExchangeFor, RETRY_TIERS,
} from '@hookrelay/shared/topology';
import { classify, type Outcome } from './classify.js';
import { config } from './config.js';
import { pool } from './db.js';
import { checkTargetUrl, deliveryAgent } from './ssrf.js';
import { publishStatus } from './status.js';

const NAME = config.ENV_WORKER_NAME;
const log = (...args: unknown[]) => console.log(`[${NAME}]`, ...args);
const logError = (...args: unknown[]) => console.error(`[${NAME}]`, ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const masterKey = Buffer.from(config.ENV_MASTER_KEY, 'base64');
if (masterKey.length !== 32) throw new Error('ENV_MASTER_KEY must be 32 bytes, base64');

const Message = z.object({
  eventId: z.string().uuid(),
  endpointId: z.string().uuid(),
  attempt: z.number().int().min(1),
  ordered: z.boolean().default(false),
});
type Msg = z.infer<typeof Message>;
type Result = { statusCode: number | null; error: string | null; latencyMs: number | null };
type Attempt = { outcome: Outcome; result: Result };
type Connection = Awaited<ReturnType<typeof amqp.connect>>;

let active: { conn: Connection; ch: ConfirmChannel; consumerTags: string[]; consumed: Set<string> } | undefined;
let standbyTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let inFlight = 0;
const stopSignal = new AbortController();
const closedChannels = new WeakSet<ConfirmChannel>();

// Wait `ms`, but stop early if the worker is shutting down. Returns false if stopped.
function pause(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (stopping) return resolve(false);
    const onStop = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => {
      stopSignal.signal.removeEventListener('abort', onStop);
      resolve(true);
    }, ms);
    stopSignal.signal.addEventListener('abort', onStop, { once: true });
  });
}

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code;
  const message = e?.cause?.message ?? e?.message ?? String(err);
  return (code && !message.startsWith(code) ? `${code}: ${message}` : message).slice(0, 500);
}

function publish(ch: ConfirmChannel, exchange: string, routingKey: string, content: Buffer, options: Options.Publish) {
  return new Promise<void>((resolve, reject) => {
    ch.publish(exchange, routingKey, content, options, (err) => (err ? reject(err) : resolve()));
  });
}

const msgOptions = (m: Msg): Options.Publish => ({
  persistent: true, messageId: m.eventId, contentType: 'application/json',
});
const label = (a: Attempt) => a.result.statusCode ?? a.result.error;

async function record(m: Msg, result: Result, newStatus: 'delivered' | 'dead' | null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO delivery_attempts (event_id, attempt, status_code, error, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [m.eventId, m.attempt, result.statusCode, result.error, result.latencyMs],
    );
    if (newStatus) {
      await client.query(`UPDATE events SET status = $2 WHERE id = $1 AND status = 'pending'`, [m.eventId, newStatus]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function attemptDelivery(m: Msg): Promise<Attempt | null> {
  const { rows } = await pool.query(
    `SELECT e.status, e.payload, ep.id AS endpoint_id, ep.target_url, ep.outbound_secret, ep.disabled_at
       FROM events e
       JOIN endpoints ep ON ep.id = e.endpoint_id
      WHERE e.id = $1`,
    [m.eventId],
  );
  const ev = rows[0];
  if (!ev || ev.status !== 'pending') return null;

  if (ev.disabled_at) {
    return { outcome: 'dead', result: { statusCode: null, error: 'endpoint disabled', latencyMs: null } };
  }
  const urlProblem = checkTargetUrl(ev.target_url);
  if (urlProblem) {
    return { outcome: 'dead', result: { statusCode: null, error: urlProblem, latencyMs: null } };
  }

  const body = JSON.stringify(ev.payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = openSecret(masterKey, ev.outbound_secret, ev.endpoint_id);

  const started = performance.now();
  let statusCode: number | null = null;
  let error: unknown = null;
  try {
    const res = await request(ev.target_url, {
      method: 'POST',
      dispatcher: deliveryAgent,
      headers: {
        'content-type': 'application/json',
        'webhook-id': m.eventId,
        'webhook-timestamp': ts,
        'webhook-signature': sign(secret, m.eventId, ts, body),
      },
      body,
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    statusCode = res.statusCode;
    await res.body.dump();
  } catch (err) {
    error = err;
  }
  const latencyMs = Math.round(performance.now() - started);
  return {
    outcome: classify(statusCode, error),
    result: { statusCode, error: error ? errorText(error) : null, latencyMs },
  };
}

async function markDelivered(m: Msg, a: Attempt) {
  await record(m, a.result, 'delivered');
  log(`event ${m.eventId} attempt ${m.attempt} → ${label(a)} ✔ delivered`);
  publishStatus(m, 'delivered', a.result.statusCode);
}

async function markDead(ch: ConfirmChannel, msg: ConsumeMessage, m: Msg, a: Attempt) {
  await record(m, a.result, 'dead');
  await publish(ch, '', DEAD_QUEUE, msg.content, msgOptions(m));
  log(`event ${m.eventId} attempt ${m.attempt} → ${label(a)} ✖ dead`);
  publishStatus(m, 'dead', a.result.statusCode);
}

// Normal endpoints: a failed try goes to a retry waiting room, other messages keep flowing
async function handle(ch: ConfirmChannel, msg: ConsumeMessage, m: Msg) {
  inFlight++;
  try {
    const a = await attemptDelivery(m);
    if (!a) {
      log(`event ${m.eventId} already handled, skipping`);
      ch.ack(msg);
      return;
    }
    if (a.outcome === 'success') {
      await markDelivered(m, a);
    } else if (a.outcome === 'retry' && m.attempt < MAX_ATTEMPTS) {
      await record(m, a.result, null);
      const exchange = retryExchangeFor(m.attempt);
      const next = Buffer.from(JSON.stringify({ ...m, attempt: m.attempt + 1 }));
      await publish(ch, exchange, msg.fields.routingKey, next, msgOptions(m));
      log(`event ${m.eventId} attempt ${m.attempt} → ${label(a)}, retrying via ${exchange}`);
      publishStatus(m, 'retrying', a.result.statusCode);
    } else {
      await markDead(ch, msg, m, a);
    }
    ch.ack(msg);
  } catch (err) {
    logError('unexpected error, retrying in 1s:', (err as Error).message);
    setTimeout(() => { try { ch.nack(msg, false, true); } catch { /* channel gone */ } }, 1000);
  } finally {
    inFlight--;
  }
}

// Ordered endpoints: retry right here and hold back this endpoint's next messages until done
async function handleOrdered(ch: ConfirmChannel, msg: ConsumeMessage, first: Msg) {
  inFlight++;
  try {
    let m = first;
    while (!stopping && !closedChannels.has(ch)) {
      try {
        const a = await attemptDelivery(m);
        if (!a) {
          ch.ack(msg);
          return;
        }
        if (a.outcome === 'success') {
          await markDelivered(m, a);
          ch.ack(msg);
          return;
        }
        if (a.outcome === 'retry' && m.attempt < MAX_ATTEMPTS) {
          await record(m, a.result, null);
          publishStatus(m, 'retrying', a.result.statusCode);
          const waitMs = RETRY_TIERS[m.attempt - 1]!.ttlMs;
          log(`ordered event ${m.eventId} attempt ${m.attempt} → ${label(a)}, waiting ${waitMs / 1000}s (endpoint paused)`);
          // Shutting down: leave it unacked so RabbitMQ gives it back, still in order
          if (!(await pause(waitMs))) return;
          m = { ...m, attempt: m.attempt + 1 };
          continue;
        }
        await markDead(ch, msg, m, a);
        ch.ack(msg);
        return;
      } catch (err) {
        // Don't nack: the next message would overtake this one. Try the same one again.
        logError(`ordered event ${m.eventId}: unexpected error, trying again in 2s:`, (err as Error).message);
        if (!(await pause(2000))) return;
      }
    }
  } finally {
    inFlight--;
  }
}

// One chain per ordered endpoint: its messages run strictly one after another
const chains = new Map<string, Promise<void>>();
function serial(key: string, fn: () => Promise<void>) {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn).catch(() => {});
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
}

function onDelivery(ch: ConfirmChannel, msg: ConsumeMessage) {
  let json: unknown = null;
  try { json = JSON.parse(msg.content.toString()); } catch { /* handled below */ }
  const parsed = Message.safeParse(json);
  if (!parsed.success) {
    logError('bad message, dropping it');
    try { ch.nack(msg, false, false); } catch { /* channel gone */ }
    return;
  }
  const m = parsed.data;
  if (m.ordered) serial(m.endpointId, () => handleOrdered(ch, msg, m));
  else void handle(ch, msg, m);
}

async function consume(partition: string) {
  const a = active;
  if (!a || stopping || a.consumed.has(partition)) return;
  a.consumed.add(partition);
  const { consumerTag } = await a.ch.consume(
    queueFor(partition),
    (msg) => { if (msg) onDelivery(a.ch, msg); },
    { noAck: false },
  );
  a.consumerTags.push(consumerTag);
}

// Join every partition's queue. Where another worker is already active,
// single-active-consumer keeps us waiting as a standby.
async function consumeAll() {
  for (const p of partitions.current()) {
    try { await consume(p); } catch (err) { logError(`could not join ${p}:`, (err as Error).message); }
  }
  log(`standing by on all ${partitions.current().length} partitions`);
}

const partitions = await watchPartitions(config.ENV_REDIS_URL, (list) => {
  log(`partitions changed → ${list.join(', ')}`);
  const a = active;
  if (!a) return;
  assertTopology(a.ch, list).then(consumeAll)
    .catch((err) => logError('could not join new partitions:', (err as Error).message));
});

async function start(): Promise<void> {
  if (stopping) return;
  let conn: Connection | undefined;
  try {
    conn = await amqp.connect(config.ENV_RABBIT_URL);
    conn.on('error', (err) => logError('rabbitmq error:', err.message));
    conn.on('close', () => {
      clearTimeout(standbyTimer);
      if (!stopping) {
        logError('connection lost, reconnecting in 2s...');
        setTimeout(start, 2000);
      }
    });

    const ch = await conn.createConfirmChannel();
    ch.on('close', () => closedChannels.add(ch));
    const list = partitions.current();
    await assertTopology(ch, list);
    await ch.prefetch(config.ENV_WORKER_PREFETCH);
    active = { conn, ch, consumerTags: [], consumed: new Set() };

    // Primary partitions first, so this worker becomes their active reader
    const primary = config.ENV_WORKER_PRIMARY.length
      ? list.filter((p) => config.ENV_WORKER_PRIMARY.includes(p))
      : list;
    for (const p of primary) await consume(p);
    log(`worker reading ${primary.map(queueFor).join(', ')} (prefetch ${config.ENV_WORKER_PREFETCH})`);

    // A few seconds later, join the rest as standby
    standbyTimer = setTimeout(() => { void consumeAll(); }, config.ENV_WORKER_STANDBY_DELAY_MS);
  } catch (err) {
    logError('connect failed, retrying in 2s:', (err as Error).message);
    if (conn) {
      conn.removeAllListeners('close');
      await conn.close().catch(() => {});
    }
    setTimeout(start, 2000);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  stopSignal.abort();
  clearTimeout(standbyTimer);
  log('shutting down, finishing in-progress messages...');
  if (active) {
    for (const tag of active.consumerTags) await active.ch.cancel(tag).catch(() => {});
  }
  while (inFlight > 0) await sleep(100);
  await active?.conn.close().catch(() => {});
  await partitions.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await start();
