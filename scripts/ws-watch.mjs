import WebSocket from 'ws';
import { SignJWT } from 'jose';

const endpointId = process.argv[2];
if (!endpointId) {
  console.error('usage: node scripts/ws-watch.mjs <endpointId>');
  process.exit(1);
}
const ports = (process.env.GATEWAYS ?? '8081,8082').split(',');
const origin = process.env.ORIGIN ?? 'http://127.0.0.1:5173';
const key = new TextEncoder().encode(process.env.ENV_JWT_SECRET ?? '');
const token = process.env.BAD_TOKEN
  ? 'not-a-real-token'
  : await new SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject('ws-watch').setIssuedAt().setExpirationTime('1h').sign(key);

let index = 0;
function connect() {
  const port = ports[index % ports.length];
  const started = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } });

  ws.on('open', () => {
    console.log(`connected to :${port}`);
    if (!process.env.NO_AUTH) ws.send(JSON.stringify({ type: 'auth', token }));
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ready') {
      console.log(`logged in on ${msg.gateway}`);
      ws.send(JSON.stringify({ type: 'subscribe', endpointId }));
    } else if (msg.type === 'subscribed') {
      console.log(`subscribed to ${msg.endpointId}`);
    } else if (msg.type === 'status') {
      console.log(`${msg.at}  ${msg.outcome.padEnd(9)} attempt ${msg.attempt}  ${msg.eventId}`);
    }
  });
  ws.on('close', (code, reason) => {
    console.log(`closed by :${port} code=${code} ${reason} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (code === 4401) process.exit(0);
    index++;
    setTimeout(connect, 1000);
  });
  ws.on('error', (err) => console.log(`error on :${port}: ${err.message}`));
}
connect();
