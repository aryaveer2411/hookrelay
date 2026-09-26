import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from './config.js';
import { takeToken } from './ratelimit.js';

declare module 'fastify' {
  interface FastifyRequest { admin?: string }
}

const jwtKey = new TextEncoder().encode(config.ENV_JWT_SECRET);
const TOKEN_TTL_SEC = 8 * 60 * 60;
const staticToken = createHash('sha256').update(config.ENV_ADMIN_TOKEN).digest();

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(got, expected);
}

async function whoIs(req: FastifyRequest): Promise<string | null> {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);

  // A JWT from the dashboard login
  if (token.split('.').length === 3) {
    try {
      const { payload } = await jwtVerify(token, jwtKey, { algorithms: ['HS256'] });
      return payload.role === 'admin' ? String(payload.sub) : null;
    } catch {
      return null;
    }
  }
  // The static token your scripts use
  const got = createHash('sha256').update(token).digest();
  return timingSafeEqual(got, staticToken) ? 'script' : null;
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const who = await whoIs(req);
  if (!who) return reply.code(401).send({ error: 'unauthorized' });
  req.admin = who;
}

const LoginBody = z.object({ password: z.string().min(1).max(200) });

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    // At most 1 try per second per IP, to slow down password guessing
    const limit = await takeToken(`login:${req.ip}`, 1);
    if (!limit.allowed) {
      return reply.code(429).header('Retry-After', String(limit.retryAfterSec)).send({ error: 'too many attempts' });
    }
    const { password } = LoginBody.parse(req.body);
    if (!verifyPassword(password, config.ENV_ADMIN_PASSWORD_HASH)) {
      return reply.code(401).send({ error: 'wrong password' });
    }
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SEC}s`)
      .sign(jwtKey);
    return { token, expiresInSec: TOKEN_TTL_SEC };
  });
}
