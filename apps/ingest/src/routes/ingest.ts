import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { redis } from '../redis.js';
import { open, verifySignature } from '../crypto.js';
import { takeToken } from '../ratelimit.js';

const DEDUP_TTL_SEC = 86_400; // remember webhook-ids for 24 hours

const Params = z.object({ endpointId: z.string().uuid() });
const Headers = z.object({
  'webhook-id': z.string().min(1).max(255),
  'webhook-timestamp': z.string().regex(/^\d+$/),
  'webhook-signature': z.string().min(1).max(2048),
});

export async function ingestRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/in/:endpointId', { bodyLimit: 262_144 }, async (req, reply) => {
    const params = Params.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'unknown endpoint' });
    const headers = Headers.safeParse(req.headers);
    if (!headers.success) return reply.code(400).send({ error: 'missing or invalid webhook headers' });

    const { endpointId } = params.data;
    const { 'webhook-id': webhookId, 'webhook-timestamp': ts, 'webhook-signature': sig } = headers.data;
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'body required' });

    // 1. Find the endpoint
    const { rows } = await pool.query(
      'SELECT inbound_secret, rate_per_sec, disabled_at FROM endpoints WHERE id = $1',
      [endpointId],
    );
    const endpoint = rows[0];
    if (!endpoint) return reply.code(404).send({ error: 'unknown endpoint' });
    if (endpoint.disabled_at) return reply.code(410).send({ error: 'endpoint disabled' });

    // 2. Reject old or future timestamps
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
      return reply.code(401).send({ error: 'timestamp outside allowed window' });
    }

    // 3. Check the signature
    const secret = open(endpoint.inbound_secret, endpointId);
    if (!verifySignature(secret, webhookId, ts, body, sig)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // 4. NEW: rate limit (after the signature, so strangers can't use up your tokens)
    const limit = await takeToken(endpointId, endpoint.rate_per_sec);
    if (!limit.allowed) {
      return reply.code(429).header('Retry-After', String(limit.retryAfterSec)).send({ error: 'rate limit exceeded' });
    }

    // 5. Body must be valid JSON
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'body must be valid JSON' });
    }

    // 6. NEW: fast duplicate check in Redis
    const idemKey = `idem:${endpointId}:${webhookId}`;
    let ownsKey = false;
    try {
      ownsKey = (await redis.set(idemKey, 'pending', 'EX', DEDUP_TTL_SEC, 'NX')) === 'OK';
      if (!ownsKey) {
        const known = await redis.get(idemKey);
        if (known && known !== 'pending') {
          return reply.code(200).send({ eventId: known, duplicate: true });
        }
        // 'pending' = another request is saving it right now → Postgres decides below
      }
    } catch (err) {
      req.log.warn(`redis unavailable, using Postgres only: ${(err as Error).message}`);
    }

    // 7. Save event + outbox row together. Postgres UNIQUE is the final word on duplicates.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO events (endpoint_id, external_id, payload, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (endpoint_id, external_id) DO NOTHING
         RETURNING id`,
        [endpointId, webhookId, JSON.stringify(payload)],
      );

      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        const existing = await pool.query(
          'SELECT id FROM events WHERE endpoint_id = $1 AND external_id = $2',
          [endpointId, webhookId],
        );
        const eventId = existing.rows[0].id as string;
        if (ownsKey) await redis.set(idemKey, eventId, 'EX', DEDUP_TTL_SEC).catch(() => { });
        return reply.code(200).send({ eventId, duplicate: true });
      }

      const eventId = inserted.rows[0].id as string;
      await client.query('INSERT INTO outbox (event_id) VALUES ($1)', [eventId]);
      await client.query('COMMIT');
      if (ownsKey) await redis.set(idemKey, eventId, 'EX', DEDUP_TTL_SEC, 'XX').catch(() => { });
      redis.publish(`endpoint:${endpointId}`, JSON.stringify({
        type: 'status', eventId, endpointId, externalId: webhookId,
        attempt: 0, outcome: 'received', at: new Date().toISOString(),
      })).catch(() => { });
      return reply.code(202).send({ eventId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { });
      // Save failed: forget the key so the sender's retry isn't treated as a duplicate
      if (ownsKey) await redis.del(idemKey).catch(() => { });
      throw err;
    } finally {
      client.release();
    }
  });
}
