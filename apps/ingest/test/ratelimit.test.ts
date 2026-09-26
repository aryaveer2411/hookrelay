import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { redis } from '../src/redis.js';
import { takeToken } from '../src/ratelimit.js';

beforeAll(async () => {
  if (redis.status !== 'ready') await new Promise((r) => redis.once('ready', r));
});
afterAll(async () => { await redis.quit(); });

it('100 requests at once only get the bucket size (5)', async () => {
  const endpointId = `test-${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 100 }, () => takeToken(endpointId, 5)));
  const allowed = results.filter((r) => r.allowed).length;

  expect(allowed).toBeGreaterThanOrEqual(5);
  expect(allowed).toBeLessThanOrEqual(6); // 6 only if the burst took over 200 ms and a token refilled
  expect(results.find((r) => !r.allowed)?.retryAfterSec).toBe(1);

  await redis.del(`rl:${endpointId}`);
});
