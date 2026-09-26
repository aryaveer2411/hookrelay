import amqp, { type ConfirmChannel } from 'amqplib';
import { watchPartitions } from '@hookrelay/shared/partitions';
import { HashRing } from '@hookrelay/shared/ring';
import { assertTopology, DELIVER_EXCHANGE } from '@hookrelay/shared/topology';
import { config } from './config.js';
import { pool } from './db.js';

const BATCH = 200;
const POLL_MS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

// The partition list lives in Redis. Rebuild the ring whenever it changes.
let ring: HashRing;
const partitions = await watchPartitions(config.ENV_REDIS_URL, (list) => {
  ring = new HashRing(list);
  console.log(`partitions changed → ${list.join(', ')} (ring rebuilt)`);
});
ring = new HashRing(partitions.current());
console.log(`routing over partitions ${partitions.current().join(', ')}`);

type Row = { id: string; event_id: string; endpoint_id: string; ordered: boolean };
let lastHoldLog = 0;

async function tick(ch: ConfirmChannel, returned: Set<string>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Row>(
      `SELECT o.id, o.event_id, e.endpoint_id, ep.ordered
         FROM outbox o
         JOIN events e ON e.id = o.event_id
         JOIN endpoints ep ON ep.id = e.endpoint_id
        WHERE o.sent_at IS NULL
        ORDER BY o.id
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED`,
      [BATCH],
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { count: 0, sent: 0 };
    }

    // 1. Where does each endpoint go? (same ring for the whole batch)
    const currentRing = ring;
    const target = new Map<string, string>();
    for (const r of rows) {
      if (!target.has(r.endpoint_id)) target.set(r.endpoint_id, currentRing.get(r.endpoint_id));
    }

    // 2. Safe rebalance: if an endpoint still has unfinished messages on a DIFFERENT
    //    partition (because the ring changed), hold its new rows until those finish.
    const inflight = await client.query<{ endpoint_id: string; partition: string }>(
      `SELECT DISTINCT e.endpoint_id, o.partition
         FROM events e
         JOIN outbox o ON o.event_id = e.id
        WHERE e.endpoint_id = ANY($1::uuid[])
          AND e.status = 'pending'
          AND o.sent_at IS NOT NULL
          AND o.partition IS NOT NULL
          AND e.id <> ALL($2::uuid[])`,
      [[...target.keys()], rows.map((r) => r.event_id)],
    );
    const held = new Set<string>();
    for (const f of inflight.rows) {
      if (f.partition !== target.get(f.endpoint_id)) held.add(f.endpoint_id);
    }

    // 3. Publish everything that isn't held, in outbox order
    returned.clear();
    const toSend = rows.filter((r) => !held.has(r.endpoint_id));
    for (const r of toSend) {
      const message = { eventId: r.event_id, endpointId: r.endpoint_id, attempt: 1, ordered: r.ordered };
      ch.publish(DELIVER_EXCHANGE, target.get(r.endpoint_id)!, Buffer.from(JSON.stringify(message)), {
        persistent: true,
        mandatory: true,
        messageId: r.event_id,
        contentType: 'application/json',
      });
    }
    if (toSend.length > 0) await ch.waitForConfirms();

    const sent = toSend.filter((r) => !returned.has(r.event_id));
    if (sent.length < toSend.length) {
      console.warn(`${toSend.length - sent.length} message(s) had no queue to go to`);
    }
    if (held.size > 0 && Date.now() - lastHoldLog > 5000) {
      lastHoldLog = Date.now();
      console.log(`holding ${rows.length - toSend.length} row(s) for ${held.size} endpoint(s) until their old partition finishes`);
    }

    // 4. Mark sent and remember which partition each one went to
    if (sent.length > 0) {
      await client.query(
        `UPDATE outbox AS o
            SET sent_at = now(), partition = v.partition
           FROM unnest($1::bigint[], $2::text[]) AS v(id, partition)
          WHERE o.id = v.id`,
        [sent.map((r) => r.id), sent.map((r) => target.get(r.endpoint_id)!)],
      );
    }
    await client.query('COMMIT');
    if (sent.length > 0) console.log(`published ${sent.length} message(s)`);
    return { count: rows.length, sent: sent.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  while (!stopping) {
    let conn: Awaited<ReturnType<typeof amqp.connect>> | undefined;
    try {
      conn = await amqp.connect(config.ENV_RABBIT_URL);
      let broken = false;
      conn.on('error', (err) => console.error('rabbitmq error:', err.message));
      conn.on('close', () => { broken = true; });

      const ch = await conn.createConfirmChannel();
      ch.on('error', (err) => console.error('channel error:', err.message));
      ch.on('close', () => { broken = true; });
      await assertTopology(ch, partitions.current());

      const returned = new Set<string>();
      ch.on('return', (msg) => returned.add(String(msg.properties.messageId)));

      console.log('relay connected, watching the outbox');
      while (!stopping && !broken) {
        const r = await tick(ch, returned);
        if (r.sent === 0 || r.count < BATCH) await sleep(POLL_MS);
      }
    } catch (err) {
      console.error('relay error:', (err as Error).message);
    } finally {
      await conn?.close().catch(() => {});
    }
    if (!stopping) {
      console.log('reconnecting in 2s...');
      await sleep(2000);
    }
  }
  await partitions.close();
  await pool.end();
}

await run();
