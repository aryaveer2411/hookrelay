import amqp from 'amqplib';
import { publishPartitions, readPartitions } from '@hookrelay/shared/partitions';
import { assertTopology } from '@hookrelay/shared/topology';
import { config } from './config.js';

const current = await readPartitions(config.ENV_REDIS_URL);
const nextNumber = Math.max(...current.map((p) => Number(p.slice(1)))) + 1;
const next = [...current, `p${nextNumber}`];

// 1. Create the new queue FIRST, so nothing is ever routed to a queue that doesn't exist
const conn = await amqp.connect(config.ENV_RABBIT_URL);
const ch = await conn.createChannel();
await assertTopology(ch, next);
await conn.close();

// 2. Then tell every relay and worker
await publishPartitions(config.ENV_REDIS_URL, next);
console.log(`added p${nextNumber}: partitions are now ${next.join(', ')}`);
