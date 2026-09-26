import amqp, { type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib';
import { request } from 'undici';
import { z } from 'zod';
import { assertTopology, DEAD_QUEUE, MAX_ATTEMPTS, queueFor, retryExchangeFor } from '@hookrelay/shared/topology';
import { openSecret, sign } from '@hookrelay/shared/crypto';
import { classify, type Outcome } from './classify.js';
import { config } from './config.js';
import { pool } from './db.js';
import { checkTargetUrl, deliveryAgent } from './ssrf.js';

const QUEUE = queueFor('p0');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const masterKey = Buffer.from(config.ENV_MASTER_KEY, 'base64');
if (masterKey.length !== 32) throw new Error('ENV_MASTER_KEY must be 32 bytes, base64');

const Message = z.object({
  eventId: z.string().uuid(),
  endpointId: z.string().uuid(),
  attempt: z.number().int().min(1),
});
type Msg = z.infer<typeof Message>;
type Result = { statusCode: number | null; error: string | null; latencyMs: number | null };
type Attempt = { outcome: Outcome; result: Result };

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
let active: { conn: Connection; ch: ConfirmChannel; consumerTag: string } | undefined;
let stopping = false;
let inFlight = 0;

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code;
  const message = e?.cause?.message ?? e?.message ?? String(err);
  return (code && !message.startsWith(code) ? `${code}: ${message}` : message).slice(0, 500);
}

// Publish and wait until RabbitMQ confirms it saved the message
function publish(ch: ConfirmChannel, exchange: string, routingKey: string, content: Buffer, options: Options.Publish) {
  return new Promise<void>((resolve, reject) => {
    ch.publish(exchange, routingKey, content, options, (err) => (err ? reject(err) : resolve()));
  });
}

// Save the attempt; also change the event status if newStatus is given (null = stays 'pending')
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

// Try one delivery. Returns null when there is nothing to do (already handled).
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

  // Sign the outgoing webhook with this endpoint's outbound secret
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

async function handle(ch: ConfirmChannel, msg: ConsumeMessage) {
  inFlight++;
  try {
    let json: unknown = null;
    try { json = JSON.parse(msg.content.toString()); } catch { /* handled below */ }
    const parsed = Message.safeParse(json);
    if (!parsed.success) {
      console.error('bad message, dropping it');
      ch.nack(msg, false, false);
      return;
    }
    const m = parsed.data;

    const attempt = await attemptDelivery(m);
    if (!attempt) {
      console.log(`event ${m.eventId} already handled, skipping`);
      ch.ack(msg);
      return;
    }
    const label = attempt.result.statusCode ?? attempt.result.error;

    if (attempt.outcome === 'success') {
      await record(m, attempt.result, 'delivered');
      console.log(`event ${m.eventId} attempt ${m.attempt} → ${label} ✔ delivered`);
    } else if (attempt.outcome === 'retry' && m.attempt < MAX_ATTEMPTS) {
      await record(m, attempt.result, null);
      const exchange = retryExchangeFor(m.attempt);
      const next = Buffer.from(JSON.stringify({ ...m, attempt: m.attempt + 1 }));
      await publish(ch, exchange, msg.fields.routingKey, next, {
        persistent: true,
        messageId: m.eventId,
        contentType: 'application/json',
      });
      console.log(`event ${m.eventId} attempt ${m.attempt} → ${label}, retrying via ${exchange}`);
    } else {
      await record(m, attempt.result, 'dead');
      await publish(ch, '', DEAD_QUEUE, msg.content, {
        persistent: true,
        messageId: m.eventId,
        contentType: 'application/json',
      });
      console.log(`event ${m.eventId} attempt ${m.attempt} → ${label} ✖ dead`);
    }

    ch.ack(msg); // only after the next step is safely saved
  } catch (err) {
    console.error('unexpected error, retrying in 1s:', (err as Error).message);
    setTimeout(() => { try { ch.nack(msg, false, true); } catch { /* channel gone */ } }, 1000);
  } finally {
    inFlight--;
  }
}

async function start(): Promise<void> {
  if (stopping) return;
  let conn: Connection | undefined;
  try {
    conn = await amqp.connect(config.ENV_RABBIT_URL);
    conn.on('error', (err) => console.error('rabbitmq error:', err.message));
    conn.on('close', () => {
      if (!stopping) {
        console.error('connection lost, reconnecting in 2s...');
        setTimeout(start, 2000);
      }
    });

    const ch = await conn.createConfirmChannel();
    await assertTopology(ch);
    await ch.prefetch(config.ENV_WORKER_PREFETCH);
    const { consumerTag } = await ch.consume(
      QUEUE,
      (msg) => { if (msg) void handle(ch, msg); },
      { noAck: false },
    );
    active = { conn, ch, consumerTag };
    console.log(`worker reading ${QUEUE} (prefetch ${config.ENV_WORKER_PREFETCH})`);
  } catch (err) {
    console.error('connect failed, retrying in 2s:', (err as Error).message);
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
  console.log('shutting down, finishing in-progress messages...');
  if (active) await active.ch.cancel(active.consumerTag).catch(() => {});
  while (inFlight > 0) await sleep(100);
  await active?.conn.close().catch(() => {});
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await start();
