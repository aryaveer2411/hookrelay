import { readFileSync } from 'node:fs';
import pg from 'pg';

const file = process.argv[2] ?? 'accepted.txt';
const MAX_WAIT_SEC = Number(process.env.MAX_WAIT_SEC ?? 600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ids = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
if (ids.length === 0) {
  console.error(`no accepted ids in ${file}`);
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.ENV_DB_URL, max: 2 });
const count = async (sql) => (await pool.query(sql, [ids])).rows[0].n;

// 1. Wait until every accepted event is finished (delivered or dead)
const started = Date.now();
for (;;) {
  const pending = await count(
    `SELECT count(*)::int AS n FROM events WHERE id = ANY($1::uuid[]) AND status = 'pending'`);
  if (pending === 0) break;
  const waited = Math.round((Date.now() - started) / 1000);
  if (waited > MAX_WAIT_SEC) {
    console.log(`\ngave up after ${waited}s with ${pending} still pending`);
    break;
  }
  process.stdout.write(`\rwaiting for ${pending} pending event(s)... ${waited}s   `);
  await sleep(2000);
}
console.log('');

// 2. These must all be 0
const checks = {
  missing_from_database: await count(
    `SELECT count(*)::int AS n FROM unnest($1::uuid[]) AS a(id)
       LEFT JOIN events e ON e.id = a.id WHERE e.id IS NULL`),
  still_pending: await count(
    `SELECT count(*)::int AS n FROM events WHERE id = ANY($1::uuid[]) AND status = 'pending'`),
  never_sent_to_queue: await count(
    `SELECT count(*)::int AS n FROM outbox WHERE event_id = ANY($1::uuid[]) AND sent_at IS NULL`),
  delivered_but_target_never_got_it: await count(
    `SELECT count(*)::int AS n FROM events e
      WHERE e.id = ANY($1::uuid[]) AND e.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM mock.received r
                         WHERE r.webhook_id = e.id::text AND r.status_returned BETWEEN 200 AND 299)`),
  duplicate_event_rows: await count(
    `SELECT count(*)::int AS n FROM (
       SELECT endpoint_id, external_id FROM events WHERE id = ANY($1::uuid[])
        GROUP BY 1, 2 HAVING count(*) > 1) d`),
};

// 3. Just for information
const info = {
  accepted: ids.length,
  delivered: await count(`SELECT count(*)::int AS n FROM events WHERE id = ANY($1::uuid[]) AND status = 'delivered'`),
  dead: await count(`SELECT count(*)::int AS n FROM events WHERE id = ANY($1::uuid[]) AND status = 'dead'`),
  delivered_more_than_once: await count(
    `SELECT count(*)::int AS n FROM (
       SELECT webhook_id FROM mock.received WHERE webhook_id = ANY($1::text[])
        GROUP BY webhook_id HAVING count(*) > 1) d`),
};

console.log('--- info ---');
for (const [k, v] of Object.entries(info)) console.log(`  ${k.padEnd(36)} ${v}`);
console.log('--- checks (must be 0) ---');
let failed = false;
for (const [k, v] of Object.entries(checks)) {
  console.log(`  ${v === 0 ? '✔' : '✖'} ${k.padEnd(34)} ${v}`);
  if (v !== 0) failed = true;
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS — 0 lost');
await pool.end();
process.exit(failed ? 1 : 0);
