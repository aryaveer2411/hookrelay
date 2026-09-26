import { z } from 'zod';

const schema = z.object({
  ENV_JWT_SECRET: z.string().min(32),
  ENV_REDIS_URL: z.string().url(),
  ENV_GATEWAY_PORT: z.coerce.number().int().default(8081),
  ENV_GATEWAY_NAME: z.string().default('gw1'),
  ENV_ALLOWED_ORIGINS: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  ENV_TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENV_MAX_CONN_PER_IP: z.coerce.number().int().min(1).default(20),
  ENV_HOST: z.string().default('127.0.0.1'),
});

export const config = schema.parse(process.env);
