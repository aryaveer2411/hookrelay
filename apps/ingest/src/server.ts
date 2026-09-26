import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { endpointRoutes } from './routes/endpoints.js';
import { ingestRoutes } from './routes/ingest.js';
import { authRoutes } from './auth.js';
import { eventRoutes } from './routes/events.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: config.ENV_CORS_ORIGIN ? config.ENV_CORS_ORIGIN.split(',') : false,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
});

// Turn errors into clean responses (no stack traces sent to users)
app.setErrorHandler((err, req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'invalid request', issues: err.issues });
  }
  if (err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  req.log.error(err);
  return reply.code(500).send({ error: 'internal error' });
});

await app.register(authRoutes, { prefix: '/api' });
await app.register(endpointRoutes, { prefix: '/api' });
await app.register(eventRoutes, { prefix: '/api' });
await app.register(ingestRoutes);

await app.listen({ host: '127.0.0.1', port: config.ENV_PORT });
