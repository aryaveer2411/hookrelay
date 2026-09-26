import { readFileSync } from 'node:fs';
import pg from 'pg';

const since = process.env.SINCE ?? new Date(Date.now() - 15 * 60_000).toISOString();
const ids = JSON.parse(readFileSync('bench/endpoints.json', 'utf8')).map((e) => e.id);
const pool = new pg.Pool({ connectionString: process.env.ENV_DB_URL, max: 2 });

const { rows: [r] } = await pool.query(
  `WITH ev AS (
     SELECT e.id, e.status, e.received_at FROM events e
      WHERE e.endpoint_id = ANY($1::uuid[]) AND e.received_at >= $2::timestamptz
   ),
   first_ok AS (
     SELECT ev.id, ev.received_at, a.created_at AS done_at
       FROM ev JOIN delivery_attempts a ON a.event_id = ev.id AND a.attempt = 1
      WHERE a.status_code BETWEEN 200 AND 299
   )
   SELECT
     (SELECT count(*) FROM ev)::int                                  AS accepted,
     (SELECT count(*) FROM ev WHERE status = 'delivered')::int       AS delivered,
     (SELECT count(*) FROM ev WHERE status = 'pending')::int         AS pending,
     (SELECT count(*) FROM ev WHERE status = 'dead')::int            AS dead,
     round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM done_at - received_at) * 1000)::numeric, 1) AS e2e_p50_ms,
     round(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM done_at - received_at) * 1000)::numeric, 1) AS e2e_p99_ms,
     round(extract(epoch FROM max(done_at) - (SELECT max(received_at) FROM ev))::numeric, 1)                            AS drain_after_last_request_s
   FROM first_ok`,
  [ids, since],
);
console.log(`since ${since}`);
console.table(r);
await pool.end();
