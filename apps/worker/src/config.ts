import { z } from 'zod';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const schema = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_RABBIT_URL: z.string().url(),
  ENV_REDIS_URL: z.string().url(),
  ENV_MASTER_KEY: z.string().min(1),
  ENV_WORKER_PREFETCH: z.coerce.number().int().min(1).max(1000).default(20),
  ENV_SSRF_ALLOW_IPS: z.string().default('').transform(list),
  ENV_ALLOW_HTTP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENV_WORKER_NAME: z.string().default('worker'),
  ENV_WORKER_PRIMARY: z.string().default('').transform(list),     // empty = all partitions
  ENV_WORKER_STANDBY_DELAY_MS: z.coerce.number().int().min(0).default(5000),
});

export const config = schema.parse(process.env);
