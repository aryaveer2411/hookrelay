// End-to-end check against a running stack: intake → relay → worker → target,
// plus dedup, signature rejection, and the WebSocket live feed.
// Usage: set -a; source .env; set +a; node scripts/smoke.mjs
import { createHmac, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const TARGET_URL = process.env.TARGET_URL ?? 'http://mock-target:4000/hook';
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8080';
const DELIVER_TIMEOUT_MS = Number(process.env.DELIVER_TIMEOUT_MS ?? 60_000);
const TOKEN = process.env.ENV_ADMIN_TOKEN;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD;

if (!TOKEN) {
  console.error('ENV_ADMIN_TOKEN missing. Run: set -a; source .env; set +a');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
}

const api = (path, init = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers },
  });

function signedRequest(endpointId, secret, { webhookId = `smoke_${randomUUID()}`, corrupt = false } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 'smoke', at: ts });
  const key = corrupt ? Buffer.alloc(32) : secret;
  const sig = createHmac('sha256', key).update(`${webhookId}.${ts}.${body}`).digest('base64');
  return fetch(`${BASE}/in/${endpointId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${sig}`,
    },
    body,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), webhookId }));
}

// Opens the live feed. Returns { subscribed, message } — await `subscribed` before
// triggering the event, so the status message cannot be missed.
function liveFeed(token, endpointId, match) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, { headers: { origin: ORIGIN } });
  const rejectors = [];
  let onSubscribed, onMessage;
  const subscribed = new Promise((res, rej) => { onSubscribed = res; rejectors.push(rej); });
  const message = new Promise((res, rej) => { onMessage = res; rejectors.push(rej); });
  const fail = (err) => rejectors.forEach((rej) => rej(err));

  const timer = setTimeout(() => {
    ws.close();
    fail(new Error('no live status message within 60s'));
  }, 60_000);

  ws.on('error', (err) => { clearTimeout(timer); fail(err); });
  ws.on('close', () => clearTimeout(timer));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ready') ws.send(JSON.stringify({ type: 'subscribe', endpointId }));
    else if (msg.type === 'subscribed') onSubscribed();
    else if (msg.type === 'status' && match(msg)) { clearTimeout(timer); ws.close(); onMessage(msg); }
  });

  // Mark both as handled so a failure on one path is never an unhandled rejection.
  subscribed.catch(() => {});
  message.catch(() => {});

  return { subscribed, message, close: () => ws.close() };
}

console.log(`smoke test against ${BASE}`);

// 1. Admin API reachable, endpoint created
const created = await api('/endpoints', {
  method: 'POST',
  body: JSON.stringify({ name: `smoke-${Date.now()}`, targetUrl: TARGET_URL, ratePerSec: 100 }),
});
if (!check('create endpoint', created.status === 201, `HTTP ${created.status}`)) {
  console.error(await created.text());
  process.exit(1);
}
const { endpoint, inboundSecret } = await created.json();
const secret = Buffer.from(inboundSecret, 'base64');
console.log(`  endpoint ${endpoint.id}`);

// 2. A wrong signature is rejected before anything is stored
const bad = await signedRequest(endpoint.id, secret, { corrupt: true });
check('bad signature rejected', bad.status === 401, `HTTP ${bad.status}`);

// 3. A valid webhook is accepted
const first = await signedRequest(endpoint.id, secret);
check('valid webhook accepted', first.status === 202, `HTTP ${first.status}`);
const eventId = first.body?.eventId;
if (!eventId) {
  console.error('no eventId returned, cannot continue');
  process.exit(1);
}

// 4. Re-sending the same webhook-id is deduped, not stored twice
const dup = await signedRequest(endpoint.id, secret, { webhookId: first.webhookId });
check(
  'duplicate deduped',
  dup.status === 200 && dup.body?.duplicate === true && dup.body?.eventId === eventId,
  `HTTP ${dup.status} ${JSON.stringify(dup.body)}`,
);

// 5. The event reaches the target and is marked delivered
const deadline = Date.now() + DELIVER_TIMEOUT_MS;
let event = null;
let attempts = [];
while (Date.now() < deadline) {
  const res = await api(`/events/${eventId}`);
  if (res.ok) {
    const data = await res.json();
    event = data.event;
    attempts = data.attempts;
    if (event.status !== 'pending') break;
  }
  await sleep(500);
}
const waited = Math.round((DELIVER_TIMEOUT_MS - (deadline - Date.now())) / 1000);
check('event delivered end to end', event?.status === 'delivered', `status=${event?.status} after ${waited}s`);
check(
  'target answered 2xx',
  attempts.some((a) => a.status_code >= 200 && a.status_code < 300),
  JSON.stringify(attempts.map((a) => a.status_code ?? a.error)),
);

// 6. Login + WebSocket live feed (skipped unless SMOKE_ADMIN_PASSWORD is set)
if (ADMIN_PASSWORD) {
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  const jwt = login.ok ? (await login.json()).token : null;
  if (check('admin login', Boolean(jwt), `HTTP ${login.status}`)) {
    try {
      const live = liveFeed(jwt, endpoint.id, (m) => m.outcome === 'delivered');
      await live.subscribed;                      // subscribed, so we cannot miss the event
      await signedRequest(endpoint.id, secret);   // trigger one more delivery
      const msg = await live.message;
      check('live feed reported delivery', msg.outcome === 'delivered', `eventId=${msg.eventId}`);
    } catch (err) {
      check('live feed reported delivery', false, err.message);
    }
  }
} else {
  console.log('  — live feed check skipped (set SMOKE_ADMIN_PASSWORD to enable)');
}

console.log(failed === 0 ? '\nSMOKE: PASS' : `\nSMOKE: FAIL (${failed} check(s))`);
process.exit(failed === 0 ? 0 : 1);
