import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { open, verifySignature } from '../crypto.js';

const Params = z.object({ endpointId: z.string().uuid() });
const Headers = z.object({
  'webhook-id': z.string().min(1).max(255),
  'webhook-timestamp': z.string().regex(/^\d+$/),
  'webhook-signature': z.string().min(1).max(2048),
});

export async function ingestRoutes(app: FastifyInstance) {
  // Keep the raw bytes: the signature is calculated over the exact body
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
      'SELECT inbound_secret, disabled_at FROM endpoints WHERE id = $1',
      [endpointId],
    );
    const endpoint = rows[0];
    if (!endpoint) return reply.code(404).send({ error: 'unknown endpoint' });
    if (endpoint.disabled_at) return reply.code(410).send({ error: 'endpoint disabled' });

    // 2. Reject old or future timestamps (more than 5 minutes off)
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
      return reply.code(401).send({ error: 'timestamp outside allowed window' });
    }

    // 3. Check the signature
    const secret = open(endpoint.inbound_secret, endpointId);
    if (!verifySignature(secret, webhookId, ts, body, sig)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // 4. Body must be valid JSON
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'body must be valid JSON' });
    }

    // 5. Save event + outbox row together (both or neither)
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
        // Same webhook-id seen before: return the original event
        await client.query('ROLLBACK');
        const existing = await pool.query(
          'SELECT id FROM events WHERE endpoint_id = $1 AND external_id = $2',
          [endpointId, webhookId],
        );
        return reply.code(200).send({ eventId: existing.rows[0].id, duplicate: true });
      }

      const eventId = inserted.rows[0].id;
      await client.query('INSERT INTO outbox (event_id) VALUES ($1)', [eventId]);
      await client.query('COMMIT');
      return reply.code(202).send({ eventId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
