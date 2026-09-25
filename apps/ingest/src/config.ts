import { z } from 'zod';

const schema = z.object({
  ENV_DB_URL: z.string().url(),
  ENV_MASTER_KEY: z.string().min(1),
  ENV_ADMIN_TOKEN: z.string().min(24),
  ENV_PORT: z.coerce.number().int().default(3000),
});

export const config = schema.parse(process.env);
