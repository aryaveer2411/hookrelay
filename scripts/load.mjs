import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const RATE = Number(process.env.RATE ?? 100);          // requests per second
const DURATION = Number(process.env.DURATION ?? 60);   // seconds
const OUT = process.env.OUT ?? 'accepted.txt';
const DUP_EVERY = Number(process.env.DUP_EVERY ?? 0);  // every Nth request re-sends an old webhook-id
const TOKEN = process.env.ENV_ADMIN_TOKEN;
if (!TOKEN) {
  console.error('ENV_ADMIN_TOKEN missing. Run: set -a; source .env; set +a');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Create a fresh endpoint with a high rate limit, just for this run
const created = await fetch(`${BASE}/api/endpoints`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: `load-${Date.now()}`, targetUrl: process.env.TARGET_URL ?? 'http://127.0.0.1:4000/hook', ratePerSec: 1000 }),
});
if (!created.ok) {
  console.error('could not create endpoint:', created.status, await created.text());
  process.exit(1);
}
const { endpoint, inboundSecret } = await created.json();
const secret = Buffer.from(inboundSecret, 'base64');

const accepted = [];   // event ids that got 202
const sentIds = [];    // webhook-ids sent so far (for duplicates)
const counts = {};
const bump = (k) => { counts[k] = (counts[k] ?? 0) + 1; };

async function sendOne(webhookId, n, isDup) {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 'load', n });
  const sig = createHmac('sha256', secret).update(`${webhookId}.${ts}.${body}`).digest('base64');
  try {
    const res = await fetch(`${BASE}/in/${endpoint.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${sig}`,
      },
      body,
    });
    bump(isDup ? `dup_${res.status}` : String(res.status));
    if (res.status === 202) accepted.push((await res.json()).eventId);
    else await res.text();
  } catch {
    bump('network_error');
  }
}

// 2. Send at a steady rate
console.log(`sending ${RATE}/s for ${DURATION}s to endpoint ${endpoint.id}`);
const total = RATE * DURATION;
const started = Date.now();
const inFlight = [];
for (let i = 0; i < total; i++) {
  const wait = started + (i * 1000) / RATE - Date.now();
  if (wait > 0) await sleep(wait);

  const isDup = DUP_EVERY > 0 && i % DUP_EVERY === 0 && sentIds.length > 0;
  const id = isDup ? sentIds[Math.floor(Math.random() * sentIds.length)] : `load_${randomUUID()}`;
  if (!isDup) sentIds.push(id);
  inFlight.push(sendOne(id, i, isDup));

  if (i % RATE === 0) process.stdout.write(`\r  ${Math.round((Date.now() - started) / 1000)}s, sent ${i}`);
}
await Promise.all(inFlight);

// 3. Save the accepted ids for the reconcile script
writeFileSync(OUT, accepted.join('\n') + '\n');
console.log(`\ndone. responses: ${JSON.stringify(counts)}`);
console.log(`${accepted.length} accepted event ids written to ${OUT}`);
