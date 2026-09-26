import Fastify from 'fastify';
import pg from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const env = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_MOCK_OUTBOUND_SECRET: z.string().optional(),
}).parse(process.env);

const pool = new pg.Pool({ connectionString: env.ENV_DB_URL, max: 5 });
const outboundSecret = env.ENV_MOCK_OUTBOUND_SECRET ? Buffer.from(env.ENV_MOCK_OUTBOUND_SECRET, 'base64') : null;
const app = Fastify({ logger: false });

let forcedStatus = 200;
let forcedUntil = 0;

// Keep raw bytes so we can check the signature exactly
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

function signatureNote(id: string, ts: string, raw: Buffer, header: string): string {
  if (!outboundSecret) return 'signature not checked';
  const expected = createHmac('sha256', outboundSecret).update(`${id}.${ts}.`).update(raw).digest();
  const got = Buffer.from(header.replace(/^v1,/, ''), 'base64');
  return got.length === expected.length && timingSafeEqual(got, expected) ? 'signature OK' : 'signature BAD';
}

app.post('/hook', async (req, reply) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const webhookId = String(req.headers['webhook-id'] ?? '');
  const note = signatureNote(
    webhookId,
    String(req.headers['webhook-timestamp'] ?? ''),
    raw,
    String(req.headers['webhook-signature'] ?? ''),
  );
  const status = Date.now() < forcedUntil ? forcedStatus : 200;

  let body: unknown = null;
  try { body = JSON.parse(raw.toString('utf8')); } catch { /* keep null */ }

  await pool.query(
    'INSERT INTO mock.received (webhook_id, status_returned, body) VALUES ($1, $2, $3)',
    [webhookId, status, JSON.stringify(body)],
  );
  console.log(`received ${webhookId} → answered ${status} (${note})`);
  return reply.code(status).send({ ok: status < 300 });
});

const Mode = z.object({
  status: z.number().int().min(100).max(599),
  durationSec: z.number().int().min(1).max(3600),
});

app.post('/_mode', async (req) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}';
  const { status, durationSec } = Mode.parse(JSON.parse(raw));
  forcedStatus = status;
  forcedUntil = Date.now() + durationSec * 1000;
  console.log(`mode: answering ${status} for ${durationSec}s`);
  return { status, until: new Date(forcedUntil).toISOString() };
});

await app.listen({ host: '127.0.0.1', port: 4000 });
console.log('mock target listening on http://127.0.0.1:4000');
