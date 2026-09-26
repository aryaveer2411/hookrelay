import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const ENDPOINTS = Number(process.env.ENDPOINTS ?? 20);
const RATE_PER_ENDPOINT = Number(process.env.RATE_PER_ENDPOINT ?? 5); // per second
const DURATION = Number(process.env.DURATION ?? 60);
const OUT = process.env.OUT ?? 'accepted.txt';
const TOKEN = process.env.ENV_ADMIN_TOKEN;
if (!TOKEN) {
  console.error('ENV_ADMIN_TOKEN missing. Run: set -a; source .env; set +a');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createEndpoint(i) {
  const res = await fetch(`${BASE}/api/endpoints`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `ordered-load-${i}-${Date.now()}`,
      targetUrl: 'http://127.0.0.1:4000/hook',
      ratePerSec: 100,
      ordered: true,
    }),
  });
  if (!res.ok) throw new Error(`could not create endpoint: ${res.status} ${await res.text()}`);
  return res.json();
}

const accepted = [];
const counts = {};
const bump = (k) => { counts[k] = (counts[k] ?? 0) + 1; };

// Each endpoint sends ONE message at a time, like a real sender of ordered events
async function sender({ endpoint, inboundSecret }) {
  const secret = Buffer.from(inboundSecret, 'base64');
  const end = Date.now() + DURATION * 1000;
  let n = 0;
  while (Date.now() < end) {
    const started = Date.now();
    n++;
    const id = `ord_${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'ordered', seq: n });
    const sig = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
    try {
      const res = await fetch(`${BASE}/in/${endpoint.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'webhook-id': id,
          'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}`,
        },
        body,
      });
      bump(String(res.status));
      if (res.status === 202) accepted.push((await res.json()).eventId);
      else await res.text();
    } catch {
      bump('network_error');
    }
    const wait = 1000 / RATE_PER_ENDPOINT - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
}

const endpoints = await Promise.all(Array.from({ length: ENDPOINTS }, (_, i) => createEndpoint(i)));
console.log(`${ENDPOINTS} ordered endpoints, ${RATE_PER_ENDPOINT}/s each, for ${DURATION}s`);
await Promise.all(endpoints.map(sender));
writeFileSync(OUT, accepted.join('\n') + '\n');
console.log(`done. responses: ${JSON.stringify(counts)}`);
console.log(`${accepted.length} accepted event ids written to ${OUT}`);
