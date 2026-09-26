import { z } from 'zod';

const schema = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_RABBIT_URL: z.string().url(),
  ENV_MASTER_KEY: z.string().min(1),
  ENV_WORKER_PREFETCH: z.coerce.number().int().min(1).max(1000).default(20),
  ENV_SSRF_ALLOW_IPS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  ENV_ALLOW_HTTP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const config = schema.parse(process.env);
