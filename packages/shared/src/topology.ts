import type { Channel } from 'amqplib';

export const DELIVER_EXCHANGE = 'deliver.exchange';

// Stage 10 grows this list to p0..p7
export const PARTITIONS = ['p0'] as const;

export const queueFor = (partition: string) => `deliver.${partition}`;

// Safe to call many times: RabbitMQ only creates things that don't exist yet
export async function assertTopology(ch: Channel): Promise<void> {
  await ch.assertExchange(DELIVER_EXCHANGE, 'direct', { durable: true });
  for (const p of PARTITIONS) {
    const queue = queueFor(p);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-single-active-consumer': true,
      },
    });
    await ch.bindQueue(queue, DELIVER_EXCHANGE, p);
  }
}
