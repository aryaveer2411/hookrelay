import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { jwtVerify } from 'jose';
import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { config } from './config.js';

const AUTH_TIMEOUT_MS = 5_000;       // must log in within 5s
const PING_EVERY_MS = 25_000;        // "are you still there?" every 25s
const MAX_MISSED_PONGS = 2;          // no answer twice → disconnect
const MAX_BUFFER_BYTES = 1_048_576;  // 1 MB waiting to send → client too slow, drop it
const MAX_SUBSCRIPTIONS = 50;

const jwtKey = new TextEncoder().encode(config.ENV_JWT_SECRET);
const allowedOrigins = new Set(config.ENV_ALLOWED_ORIGINS);

type Client = {
  ws: WebSocket;
  ip: string;
  authed: boolean;
  authStarted: boolean;
  missedPongs: number;
  endpoints: Set<string>;
};
const clients = new Set<Client>();
const rooms = new Map<string, Set<Client>>(); // endpointId → clients watching it
const perIp = new Map<string, number>();

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('subscribe'), endpointId: z.string().uuid() }),
  z.object({ type: z.literal('unsubscribe'), endpointId: z.string().uuid() }),
]);

// One Redis connection for this gateway, used only for listening
const sub = new Redis(config.ENV_REDIS_URL);
sub.on('error', (err) => console.error('redis error:', err.message));
sub.on('message', (channel: string, message: string) => {
  const room = rooms.get(channel.slice('endpoint:'.length));
  if (!room) return;
  for (const c of room) send(c, message);
});

function send(c: Client, data: string) {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  if (c.ws.bufferedAmount > MAX_BUFFER_BYTES) {
    console.warn(`dropping slow client ${c.ip}`);
    c.ws.terminate();
    return;
  }
  c.ws.send(data);
}
const sendJson = (c: Client, obj: unknown) => send(c, JSON.stringify(obj));

// First watcher of an endpoint → start listening to its Redis channel
function join(c: Client, endpointId: string) {
  if (c.endpoints.has(endpointId)) return;
  if (c.endpoints.size >= MAX_SUBSCRIPTIONS) {
    sendJson(c, { type: 'error', message: 'too many subscriptions' });
    return;
  }
  let room = rooms.get(endpointId);
  if (!room) {
    room = new Set();
    rooms.set(endpointId, room);
    sub.subscribe(`endpoint:${endpointId}`).catch((err) => console.error('subscribe failed:', err.message));
  }
  room.add(c);
  c.endpoints.add(endpointId);
  sendJson(c, { type: 'subscribed', endpointId });
}

// Last watcher leaves → stop listening
function leave(c: Client, endpointId: string) {
  c.endpoints.delete(endpointId);
  const room = rooms.get(endpointId);
  if (!room) return;
  room.delete(c);
  if (room.size === 0) {
    rooms.delete(endpointId);
    sub.unsubscribe(`endpoint:${endpointId}`).catch(() => {});
  }
}

async function onMessage(c: Client, raw: RawData, isBinary: boolean) {
  if (isBinary) return c.ws.close(1003, 'text only');
  let json: unknown = null;
  try { json = JSON.parse(raw.toString()); } catch { /* handled below */ }
  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) return c.ws.close(1008, 'bad message');
  const msg = parsed.data;

  // The first message must be a valid login pass
  if (!c.authed) {
    if (msg.type !== 'auth' || c.authStarted) return c.ws.close(4401, 'unauthorized');
    c.authStarted = true;
    try {
      const { payload } = await jwtVerify(msg.token, jwtKey, { algorithms: ['HS256'] });
      if (payload.role !== 'admin') throw new Error('not admin');
      c.authed = true;
      sendJson(c, { type: 'ready', gateway: config.ENV_GATEWAY_NAME });
    } catch {
      c.ws.close(4401, 'unauthorized');
    }
    return;
  }

  // Single admin, so the admin owns every endpoint
  if (msg.type === 'subscribe') join(c, msg.endpointId);
  else if (msg.type === 'unsubscribe') leave(c, msg.endpointId);
}

function clientIp(req: IncomingMessage): string {
  if (config.ENV_TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function onConnection(ws: WebSocket, ip: string) {
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  const c: Client = { ws, ip, authed: false, authStarted: false, missedPongs: 0, endpoints: new Set() };
  clients.add(c);

  const authTimer = setTimeout(() => {
    if (!c.authed) ws.close(4401, 'auth timeout');
  }, AUTH_TIMEOUT_MS);

  ws.on('pong', () => { c.missedPongs = 0; });
  ws.on('message', (raw, isBinary) => void onMessage(c, raw, isBinary));
  ws.on('error', () => { /* 'close' follows */ });
  ws.on('close', () => {
    clearTimeout(authTimer);
    clients.delete(c);
    for (const id of [...c.endpoints]) leave(c, id);
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
  });
}

// Heartbeat: find connections that died without saying goodbye
const heartbeat = setInterval(() => {
  for (const c of clients) {
    if (c.missedPongs >= MAX_MISSED_PONGS) {
      c.ws.terminate();
      continue;
    }
    c.missedPongs++;
    c.ws.ping();
  }
}, PING_EVERY_MS);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gateway: config.ENV_GATEWAY_NAME, clients: clients.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

// Checks before accepting a WebSocket: right path, allowed website, not too many from one IP
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const reject = (code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/ws') return reject(404, 'Not Found');
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return reject(403, 'Forbidden');
  const ip = clientIp(req);
  if ((perIp.get(ip) ?? 0) >= config.ENV_MAX_CONN_PER_IP) return reject(429, 'Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
});

function shutdown() {
  console.log('shutting down, telling clients to reconnect elsewhere');
  clearInterval(heartbeat);
  for (const c of clients) c.ws.close(1001, 'server shutting down');
  server.close();
  sub.quit().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(config.ENV_GATEWAY_PORT, config.ENV_HOST, () => {
  console.log(`${config.ENV_GATEWAY_NAME} listening on ws://${config.ENV_HOST}:${config.ENV_GATEWAY_PORT}/ws`);
});
