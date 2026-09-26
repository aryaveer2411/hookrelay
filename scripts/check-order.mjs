import { readFileSync } from 'node:fs';
import pg from 'pg';

const file = process.argv[2] ?? 'accepted.txt';
const ids = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const pool = new pg.Pool({ connectionString: process.env.ENV_DB_URL, max: 2 });

const { rows } = await pool.query(
  `WITH firsts AS (
     SELECT e.endpoint_id, o.id AS outbox_id, min(r.id) AS first_rx
       FROM events e
       JOIN outbox o ON o.event_id = e.id
       JOIN mock.received r ON r.webhook_id = e.id::text AND r.status_returned BETWEEN 200 AND 299
      WHERE e.id = ANY($1::uuid[])
      GROUP BY e.endpoint_id, o.id
   ),
   ranked AS (
     SELECT first_rx, lag(first_rx) OVER (PARTITION BY endpoint_id ORDER BY outbox_id) AS prev_rx
       FROM firsts
   )
   SELECT
     (SELECT count(*)::int FROM ranked WHERE prev_rx IS NOT NULL AND first_rx < prev_rx) AS out_of_order,
     (SELECT count(DISTINCT endpoint_id)::int FROM firsts) AS endpoints,
     (SELECT count(*)::int FROM firsts) AS checked`,
  [ids],
);
const { out_of_order, endpoints, checked } = rows[0];
console.log('--- ordering ---');
console.log(`  endpoints checked                 ${endpoints}`);
console.log(`  messages checked                  ${checked}`);
console.log(`  ${out_of_order === 0 ? '✔' : '✖'} out of order                     ${out_of_order}`);
console.log(out_of_order === 0 ? '\nORDER: PASS' : '\nORDER: FAIL');
await pool.end();
process.exit(out_of_order === 0 ? 0 : 1);
