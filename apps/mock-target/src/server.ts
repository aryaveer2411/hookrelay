import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

const env = z.object({ ENV_DB_URL: z.string().url() }).parse(process.env);
const pool = new pg.Pool({ connectionString: env.ENV_DB_URL, max: 5 });
const app = Fastify({ logger: false });

// Normally answer 200. POST /_mode can make it fail for a while (used in Stage 6).
let forcedStatus = 200;
let forcedUntil = 0;

app.post('/hook', async (req, reply) => {
  const webhookId = String(req.headers['webhook-id'] ?? '');
  const status = Date.now() < forcedUntil ? forcedStatus : 200;
  await pool.query(
    'INSERT INTO mock.received (webhook_id, status_returned, body) VALUES ($1, $2, $3)',
    [webhookId, status, JSON.stringify(req.body ?? null)],
  );
  console.log(`received ${webhookId} → answered ${status}`);
  return reply.code(status).send({ ok: status < 300 });
});

const Mode = z.object({
  status: z.number().int().min(100).max(599),
  durationSec: z.number().int().min(1).max(3600),
});

app.post('/_mode', async (req) => {
  const { status, durationSec } = Mode.parse(req.body);
  forcedStatus = status;
  forcedUntil = Date.now() + durationSec * 1000;
  console.log(`mode: answering ${status} for ${durationSec}s`);
  return { status, until: new Date(forcedUntil).toISOString() };
});

await app.listen({ host: '127.0.0.1', port: 4000 });
console.log('mock target listening on http://127.0.0.1:4000');
