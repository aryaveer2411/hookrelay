import { z } from 'zod';

const schema = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_RABBIT_URL: z.string().url(),
  ENV_REDIS_URL: z.string().url(),
});

export const config = schema.parse(process.env);
