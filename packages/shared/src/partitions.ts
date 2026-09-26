import { Redis } from 'ioredis';
import { DEFAULT_PARTITIONS } from './topology.js';

export const PARTITIONS_KEY = 'hookrelay:partitions';
export const PARTITIONS_CHANNEL = 'partitions:changed';

function parse(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string' && /^p\d{1,3}$/.test(p))) {
      return v as string[];
    }
  } catch { /* fall through */ }
  return null;
}

export async function readPartitions(redisUrl: string): Promise<string[]> {
  const client = new Redis(redisUrl);
  try {
    return parse(await client.get(PARTITIONS_KEY)) ?? [...DEFAULT_PARTITIONS];
  } finally {
    await client.quit();
  }
}

// Save the new list, then announce it to every relay and worker
export async function publishPartitions(redisUrl: string, list: string[]): Promise<void> {
  const client = new Redis(redisUrl);
  try {
    await client.set(PARTITIONS_KEY, JSON.stringify(list));
    await client.publish(PARTITIONS_CHANNEL, JSON.stringify(list));
  } finally {
    await client.quit();
  }
}

// Load the list, then call onChange whenever it changes
export async function watchPartitions(redisUrl: string, onChange: (partitions: string[]) => void) {
  const client = new Redis(redisUrl);
  const sub = new Redis(redisUrl);
  client.on('error', (err) => console.error('redis error:', err.message));
  sub.on('error', (err) => console.error('redis error:', err.message));

  const raw = await client.get(PARTITIONS_KEY);
  let current = parse(raw) ?? [...DEFAULT_PARTITIONS];
  if (!parse(raw)) await client.set(PARTITIONS_KEY, JSON.stringify(current));

  async function refresh() {
    const list = parse(await client.get(PARTITIONS_KEY));
    if (!list) {
      // Missing (e.g. Redis was wiped): write back what we know
      await client.set(PARTITIONS_KEY, JSON.stringify(current));
      return;
    }
    if (list.join(',') !== current.join(',')) {
      current = list;
      onChange(list);
    }
  }

  await sub.subscribe(PARTITIONS_CHANNEL);
  sub.on('message', () => {
    refresh().catch((err) => console.error('partition refresh failed:', (err as Error).message));
  });
  // Double-check every 30s in case an announcement was missed
  const timer = setInterval(() => { refresh().catch(() => {}); }, 30_000);

  return {
    current: () => current,
    close: async () => {
      clearInterval(timer);
      await Promise.allSettled([client.quit(), sub.quit()]);
    },
  };
}
