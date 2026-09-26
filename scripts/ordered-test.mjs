import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3000';
const MOCK = 'http://127.0.0.1:4000';
const COUNT = Number(process.env.COUNT ?? 5);
const FAIL_SEC = Number(process.env.FAIL_SEC ?? 50);
const auth = { authorization: `Bearer ${process.env.ENV_ADMIN_TOKEN}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new pg.Pool({ connectionString: process.env.ENV_DB_URL, max: 2 });

// 1. An ordered endpoint
const created = await fetch(`${BASE}/api/endpoints`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ name: `ordered-test-${Date.now()}`, targetUrl: `${MOCK}/hook`, ordered: true }),
});
if (!created.ok) throw new Error(`create failed: ${created.status}`);
const { endpoint, inboundSecret } = await created.json();
const secret = Buffer.from(inboundSecret, 'base64');

// 2. Make the target fail for a while
await fetch(`${MOCK}/_mode`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 503, durationSec: FAIL_SEC }),
});
console.log(`target answers 503 for ${FAIL_SEC}s`);

// 3. Send COUNT webhooks, one after another
const sent = [];
for (let i = 1; i <= COUNT; i++) {
  const id = `seq_${i}_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ seq: i });
  const sig = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  const res = await fetch(`${BASE}/in/${endpoint.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` },
    body,
  });
  if (res.status !== 202) throw new Error(`send ${i} got ${res.status}`);
  sent.push((await res.json()).eventId);
}
console.log(`sent #1..#${COUNT}`);

// 4. Wait until all are finished
const started = Date.now();
for (;;) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM events WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [sent]);
  if (rows[0].n === 0) break;
  if (Date.now() - started > (FAIL_SEC + 400) * 1000) throw new Error('timed out waiting');
  process.stdout.write(`\r${rows[0].n} still pending... ${Math.round((Date.now() - started) / 1000)}s  `);
  await sleep(2000);
}
console.log('');

// 5. In what order did the target first receive each one successfully?
const { rows } = await pool.query(
  `SELECT webhook_id, min(id) AS first_rx FROM mock.received
    WHERE webhook_id = ANY($1::text[]) AND status_returned BETWEEN 200 AND 299
    GROUP BY webhook_id ORDER BY min(id)`,
  [sent],
);
const order = rows.map((r) => sent.indexOf(r.webhook_id) + 1);
console.log(`sent order:     ${sent.map((_, i) => i + 1).join(' ')}`);
console.log(`received order: ${order.join(' ')}`);
const ok = order.length === COUNT && order.every((n, i) => n === i + 1);
console.log(ok ? 'RESULT: PASS — strict order kept' : 'RESULT: FAIL — out of order or missing');
await pool.end();
process.exit(ok ? 0 : 1);
