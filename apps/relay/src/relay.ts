import amqp, { type ConfirmChannel } from 'amqplib';
import { assertTopology, DELIVER_EXCHANGE } from '@hookrelay/shared/topology';
import { config } from './config.js';
import { pool } from './db.js';

const BATCH = 200;          // max rows per round
const POLL_MS = 100;        // wait between rounds when there's nothing to do
const ROUTING_KEY = 'p0';   // Stage 10 replaces this with the hash ring

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

// One round: read unsent rows → publish → wait for RabbitMQ → mark sent
async function tick(ch: ConfirmChannel, returned: Set<string>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; event_id: string; endpoint_id: string }>(
      `SELECT o.id, o.event_id, e.endpoint_id
         FROM outbox o
         JOIN events e ON e.id = o.event_id
        WHERE o.sent_at IS NULL
        ORDER BY o.id
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED`,
      [BATCH],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { count: 0, allRouted: true };
    }

    returned.clear();
    for (const r of rows) {
      const message = { eventId: r.event_id, endpointId: r.endpoint_id, attempt: 1 };
      ch.publish(DELIVER_EXCHANGE, ROUTING_KEY, Buffer.from(JSON.stringify(message)), {
        persistent: true,          // saved to disk
        mandatory: true,           // tell us if no queue matched
        messageId: r.event_id,
        contentType: 'application/json',
      });
    }

    // Wait until RabbitMQ confirms it has safely stored every message
    await ch.waitForConfirms();

    const sent = rows.filter((r) => !returned.has(r.event_id)).map((r) => r.id);
    if (sent.length < rows.length) {
      console.warn(`${rows.length - sent.length} message(s) had no queue to go to`);
    }
    if (sent.length > 0) {
      await client.query(
        'UPDATE outbox SET sent_at = now(), partition = $2 WHERE id = ANY($1::bigint[])',
        [sent, ROUTING_KEY],
      );
    }
    await client.query('COMMIT');
    if (sent.length > 0) console.log(`published ${sent.length} message(s)`);
    return { count: rows.length, allRouted: sent.length === rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Connect, then loop forever. If RabbitMQ goes away, wait 2s and reconnect.
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
      await assertTopology(ch);

      const returned = new Set<string>();
      ch.on('return', (msg) => returned.add(String(msg.properties.messageId)));

      console.log('relay connected, watching the outbox');
      while (!stopping && !broken) {
        const { count, allRouted } = await tick(ch, returned);
        if (!allRouted) await sleep(1000);
        else if (count < BATCH) await sleep(POLL_MS);
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
  await pool.end();
}

await run();
