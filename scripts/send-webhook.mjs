import { createHmac, randomUUID } from 'node:crypto';

const [endpointId, secretB64, message = 'hello'] = process.argv.slice(2);
if (!endpointId || !secretB64) {
  console.error('usage: node scripts/send-webhook.mjs <endpointId> <inboundSecret> [message]');
  process.exit(1);
}

const id = process.env.WEBHOOK_ID ?? `msg_${randomUUID()}`;
const ts = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ type: 'test', message });
const sig = createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${id}.${ts}.${body}`).digest('base64');

const res = await fetch(`http://127.0.0.1:3000/in/${endpointId}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${sig}`,
  },
  body,
});
console.log(res.status, await res.text());
