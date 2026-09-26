import type { Channel } from 'amqplib';

export const DELIVER_EXCHANGE = 'deliver.exchange';
export const DEAD_QUEUE = 'dead.q';
export const MAX_ATTEMPTS = 5;

// 8 partition queues to start with: deliver.p0 … deliver.p7
export const DEFAULT_PARTITIONS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] as const;

export const queueFor = (partition: string) => `deliver.${partition}`;

// Waiting rooms: a message sits here for ttlMs, then goes back to deliver.exchange
export const RETRY_TIERS = [
  { name: 'retry.10s', ttlMs: 10_000 },
  { name: 'retry.1m', ttlMs: 60_000 },
  { name: 'retry.5m', ttlMs: 300_000 },
  { name: 'retry.30m', ttlMs: 1_800_000 },
] as const;

// Attempt 1 failed → retry.10s.x, attempt 2 failed → retry.1m.x, and so on
export function retryExchangeFor(failedAttempt: number): string {
  const tier = RETRY_TIERS[failedAttempt - 1];
  if (!tier) throw new Error(`no retry tier for attempt ${failedAttempt}`);
  return `${tier.name}.x`;
}

export async function assertTopology(ch: Channel,partitions: readonly string[] = DEFAULT_PARTITIONS): Promise<void> {
  await ch.assertExchange(DELIVER_EXCHANGE, 'direct', { durable: true });

  for (const p of partitions) {
    const queue = queueFor(p);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-single-active-consumer': true },
    });
    await ch.bindQueue(queue, DELIVER_EXCHANGE, p);
  }

  for (const tier of RETRY_TIERS) {
    // fanout ignores the routing key, so the message keeps its original one ('p0')
    await ch.assertExchange(`${tier.name}.x`, 'fanout', { durable: true });
    await ch.assertQueue(tier.name, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': tier.ttlMs,
        'x-dead-letter-exchange': DELIVER_EXCHANGE,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
    });
    await ch.bindQueue(tier.name, `${tier.name}.x`, '');
  }

  await ch.assertQueue(DEAD_QUEUE, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
}
