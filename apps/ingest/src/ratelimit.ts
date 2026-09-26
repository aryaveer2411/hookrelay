import { redis } from './redis.js';

// Token bucket: each endpoint gets `rate` tokens per second, one token per request.
// Runs inside Redis as one step, so two requests can't take the same token.
const TOKEN_BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local cap  = tonumber(ARGV[2])
local t    = redis.call('TIME')
local now  = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d    = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1]) or cap
local ts     = tonumber(d[2]) or now
tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
local allowed, wait = 0, 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 60000)
return { allowed, wait }
`;

export async function takeToken(endpointId: string, ratePerSec: number) {
  try {
    const [allowed, waitMs] = (await redis.eval(
      TOKEN_BUCKET_LUA, 1, `rl:${endpointId}`, ratePerSec, ratePerSec,
    )) as [number, number];
    return { allowed: allowed === 1, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
  } catch (err) {
    // Trade-off: if Redis is down we allow the request rather than blocking all traffic
    console.warn('rate limiter unavailable, allowing request:', (err as Error).message);
    return { allowed: true, retryAfterSec: 0 };
  }
}
