import { Redis } from 'ioredis';
import { config } from './config.js';

const redis = new Redis(config.ENV_REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', (err) => console.error('redis error:', err.message));

export type LiveOutcome = 'delivered' | 'retrying' | 'dead';

// Fire-and-forget: a Redis problem must never block or fail a delivery
export function publishStatus(
  m: { eventId: string; endpointId: string; attempt: number },
  outcome: LiveOutcome,
  statusCode: number | null,
): void {
  redis.publish(`endpoint:${m.endpointId}`, JSON.stringify({
    type: 'status',
    eventId: m.eventId,
    endpointId: m.endpointId,
    attempt: m.attempt,
    outcome,
    statusCode,
    at: new Date().toISOString(),
  })).catch(() => {});
}
