import { z } from 'zod';

const schema = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_MASTER_KEY: z.string().min(1),
  ENV_ADMIN_TOKEN: z.string().min(24),
  ENV_PORT: z.coerce.number().int().default(3000),
  ENV_CORS_ORIGIN: z.string().optional(),
  ENV_REDIS_URL: z.string().url(),
  ENV_JWT_SECRET: z.string().min(32),
  ENV_ADMIN_PASSWORD_HASH: z.string().startsWith('scrypt:'),
  ENV_HOST: z.string().default('127.0.0.1'),
  ENV_TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const config = schema.parse(process.env);
