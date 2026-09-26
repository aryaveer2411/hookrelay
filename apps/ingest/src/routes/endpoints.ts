import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db.js';
import { newSecret, seal } from '../crypto.js';
import { requireAdmin } from '../auth.js';

const IdParam = z.object({ id: z.string().uuid() });

const TargetUrl = z
  .string()
  .url()
  .refine((u) => ['http:', 'https:'].includes(new URL(u).protocol), 'must be http or https');

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  targetUrl: TargetUrl,
  ratePerSec: z.number().int().min(1).max(1000).default(50),
  ordered: z.boolean().default(false),
});

const UpdateBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    targetUrl: TargetUrl.optional(),
    ratePerSec: z.number().int().min(1).max(1000).optional(),
    ordered: z.boolean().optional(),
  })
  .strict();

// Never return the secret columns from list/get/update
const PUBLIC_COLUMNS = 'id, name, target_url, rate_per_sec, ordered, disabled_at, created_at';


export async function endpointRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAdmin);

  // CREATE
  app.post('/endpoints', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const id = randomUUID();
    const inbound = newSecret();
    const outbound = newSecret();
    const { rows } = await pool.query(
      `INSERT INTO endpoints (id, name, target_url, inbound_secret, outbound_secret, rate_per_sec, ordered)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PUBLIC_COLUMNS}`,
      [id, body.name, body.targetUrl, seal(inbound, id), seal(outbound, id), body.ratePerSec, body.ordered],
    );
    // Secrets are shown only this one time
    return reply.code(201).send({
      endpoint: rows[0],
      inboundSecret: inbound.toString('base64'),
      outboundSecret: outbound.toString('base64'),
    });
  });

  // READ (list)
  app.get('/endpoints', async () => {
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM endpoints ORDER BY created_at DESC LIMIT 100`,
    );
    return { endpoints: rows };
  });

  // READ (one)
  app.get('/endpoints/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM endpoints WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // UPDATE (only the fields you send are changed)
  app.patch('/endpoints/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = UpdateBody.parse(req.body);
    const { rows } = await pool.query(
      `UPDATE endpoints SET
         name         = COALESCE($2, name),
         target_url   = COALESCE($3, target_url),
         rate_per_sec = COALESCE($4, rate_per_sec),
         ordered      = COALESCE($5, ordered)
       WHERE id = $1 AND disabled_at IS NULL
       RETURNING ${PUBLIC_COLUMNS}`,
      [id, body.name ?? null, body.targetUrl ?? null, body.ratePerSec ?? null, body.ordered ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // DELETE (soft delete: old events still point to this endpoint)
  app.delete('/endpoints/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { rowCount } = await pool.query(
      'UPDATE endpoints SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL',
      [id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });
}
