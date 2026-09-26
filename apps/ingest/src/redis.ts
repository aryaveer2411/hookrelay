import { Redis } from 'ioredis';
import { config } from './config.js';

// Fail fast when Redis is down instead of waiting; Postgres is the backup
export const redis = new Redis(config.ENV_REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on('error', (err) => console.error('redis error:', err.message));
