import amqp, { type Channel, type ConsumeMessage } from 'amqplib';
import { request } from 'undici';
import { z } from 'zod';
import { assertTopology, queueFor } from '@hookrelay/shared/topology';
import { config } from './config.js';
import { pool } from './db.js';

const QUEUE = queueFor('p0');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Message = z.object({
  eventId: z.string().uuid(),
  endpointId: z.string().uuid(),
  attempt: z.number().int().min(1),
});
type Msg = z.infer<typeof Message>;

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
let active: { conn: Connection; ch: Channel; consumerTag: string } | undefined;
let stopping = false;
let inFlight = 0;

// Save the attempt and the new status together (both or neither)
async function record(
  m: Msg,
  result: { statusCode: number | null; error: string | null; latencyMs: number | null },
  status: 'delivered' | 'dead',
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO delivery_attempts (event_id, attempt, status_code, error, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [m.eventId, m.attempt, result.statusCode, result.error, result.latencyMs],
    );
    await client.query(
      `UPDATE events SET status = $2 WHERE id = $1 AND status = 'pending'`,
      [m.eventId, status],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deliver(m: Msg) {
  const { rows } = await pool.query(
    `SELECT e.status, e.payload, ep.target_url, ep.disabled_at
       FROM events e
       JOIN endpoints ep ON ep.id = e.endpoint_id
      WHERE e.id = $1`,
    [m.eventId],
  );
  const ev = rows[0];

  if (!ev) {
    console.warn(`event ${m.eventId} not found, skipping`);
    return;
  }
  // Duplicate message (e.g. relay crashed and re-sent): already handled, skip
  if (ev.status !== 'pending') {
    console.log(`event ${m.eventId} already ${ev.status}, skipping`);
    return;
  }
  if (ev.disabled_at) {
    await record(m, { statusCode: null, error: 'endpoint disabled', latencyMs: null }, 'dead');
    return;
  }

  const body = JSON.stringify(ev.payload);
  const started = performance.now();
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const res = await request(ev.target_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': m.eventId,
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body,
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    statusCode = res.statusCode;
    await res.body.dump(); // throw away the response body, we only need the status
  } catch (err) {
    error = (err as Error).message.slice(0, 500);
  }

  const latencyMs = Math.round(performance.now() - started);
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;

  // Stage 6 replaces "dead on first failure" with retries
  await record(m, { statusCode, error, latencyMs }, ok ? 'delivered' : 'dead');
  console.log(`event ${m.eventId} → ${statusCode ?? error} (${latencyMs} ms)`);
}

async function handle(ch: Channel, msg: ConsumeMessage) {
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
    await deliver(parsed.data);
    ch.ack(msg); // only after the result is saved
  } catch (err) {
    // Something unexpected (e.g. database down): put it back and try again in 1s
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

    const ch = await conn.createChannel();
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

// Ctrl+C: stop taking new messages, finish the ones in progress, then exit
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
