import { z } from 'zod';

const schema = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_RABBIT_URL: z.string().url(),
  ENV_WORKER_PREFETCH: z.coerce.number().int().min(1).max(1000).default(20),
});

export const config = schema.parse(process.env);
