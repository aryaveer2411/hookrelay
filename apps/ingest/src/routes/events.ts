import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { pool } from '../db.js';
import { redis } from '../redis.js';

const PAGE_SIZE = 50;
const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({
  status: z.enum(['pending', 'delivered', 'dead']).optional(),
  cursor: z.string().max(300).optional(),
});
const Cursor = z.object({ t: z.string().min(1).max(64), id: z.string().uuid() });
const BulkBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

// The cursor remembers "where the last page ended" (time + id), packed into one string
const encodeCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString('base64url');
function decodeCursor(raw: string) {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

// Set dead events back to pending and put them in the outbox again, all in one step
async function replay(ids: string[], by: string): Promise<{ id: string; endpoint_id: string }[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE events SET status = 'pending'
        WHERE id = ANY($1::uuid[]) AND status = 'dead'
        RETURNING id, endpoint_id`,
      [ids],
    );
    if (rows.length > 0) {
      const replayed = rows.map((r) => r.id);
      await client.query(
        'INSERT INTO replays (event_id, replayed_by) SELECT unnest($1::uuid[]), $2',
        [replayed, by],
      );
      await client.query('INSERT INTO outbox (event_id) SELECT unnest($1::uuid[])', [replayed]);
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Tell open dashboards right away
function announceReplays(rows: { id: string; endpoint_id: string }[]) {
  for (const r of rows) {
    redis.publish(`endpoint:${r.endpoint_id}`, JSON.stringify({
      type: 'status', eventId: r.id, endpointId: r.endpoint_id,
      attempt: 0, outcome: 'replayed', at: new Date().toISOString(),
    })).catch(() => {});
  }
}

export async function eventRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAdmin);

  // History for one endpoint, newest first, 50 per page
  app.get('/endpoints/:id/events', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const q = ListQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid cursor' });

    const { rows } = await pool.query(
      `SELECT e.id, e.external_id, e.status, e.received_at,
              e.received_at::text AS cursor_ts,
              (SELECT count(*) FROM delivery_attempts a WHERE a.event_id = e.id)::int AS attempts
         FROM events e
        WHERE e.endpoint_id = $1
          AND ($2::text IS NULL OR e.status = $2)
          AND ($3::timestamptz IS NULL OR (e.received_at, e.id) < ($3::timestamptz, $4::uuid))
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT $5`,
      [id, q.status ?? null, cursor?.t ?? null, cursor?.id ?? null, PAGE_SIZE + 1],
    );

    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      events: page.map(({ cursor_ts, ...event }) => event),
      nextCursor: hasMore && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  });

  // One event with every attempt and replay
  app.get('/events/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ev = await pool.query(
      'SELECT id, endpoint_id, external_id, status, payload, received_at FROM events WHERE id = $1',
      [id],
    );
    if (!ev.rows[0]) return reply.code(404).send({ error: 'not found' });
    const attempts = await pool.query(
      `SELECT attempt, status_code, error, latency_ms, created_at
         FROM delivery_attempts WHERE event_id = $1 ORDER BY created_at, id`,
      [id],
    );
    const replays = await pool.query(
      'SELECT replayed_by, created_at FROM replays WHERE event_id = $1 ORDER BY created_at',
      [id],
    );
    return { event: ev.rows[0], attempts: attempts.rows, replays: replays.rows };
  });

  // Replay one dead event
  app.post('/events/:id/replay', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const rows = await replay([id], req.admin ?? 'unknown');
    if (rows.length === 0) {
      const found = await pool.query('SELECT status FROM events WHERE id = $1', [id]);
      if (!found.rows[0]) return reply.code(404).send({ error: 'not found' });
      return reply.code(409).send({ error: `only dead events can be replayed (this one is ${found.rows[0].status})` });
    }
    announceReplays(rows);
    return reply.code(202).send({ replayed: rows.map((r) => r.id) });
  });

  // Replay many dead events at once (max 500)
  app.post('/events/replay', async (req, reply) => {
    const ids = [...new Set(BulkBody.parse(req.body).ids)];
    const rows = await replay(ids, req.admin ?? 'unknown');
    announceReplays(rows);
    return reply.code(202).send({ replayed: rows.map((r) => r.id), skipped: ids.length - rows.length });
  });
}
