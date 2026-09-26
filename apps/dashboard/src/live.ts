import type { StatusMsg } from './types';

// Dev: Vite proxies /gw1 and /gw2. Production: nginx balances /ws across both gateways.
const GATEWAYS = import.meta.env.DEV ? ['/gw1', '/gw2'] : ['/ws'];

export type Connection = { state: 'connecting' | 'live' | 'offline'; gateway?: string };

type Options = {
  token: string;
  endpointId: string;
  startIndex: number;
  onStatus: (m: StatusMsg) => void;
  onConnection: (c: Connection) => void;
  onSubscribed: () => void;
  onAuthFailed: () => void;
};

// Connects, logs in, subscribes, and reconnects to the OTHER gateway if the connection drops.
// Returns a function that stops everything.
export function startLiveFeed(o: Options): () => void {
  let index = o.startIndex % GATEWAYS.length;
  let ws: WebSocket | null = null;
  let retries = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    o.onConnection({ state: 'connecting' });
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}${GATEWAYS[index]}`);

    ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token: o.token }));

    ws.onmessage = (e) => {
      let msg: { type?: string; gateway?: string };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.type === 'ready') {
        retries = 0;
        ws?.send(JSON.stringify({ type: 'subscribe', endpointId: o.endpointId }));
        o.onConnection({ state: 'live', gateway: msg.gateway });
      } else if (msg.type === 'subscribed') {
        o.onSubscribed();
      } else if (msg.type === 'status') {
        o.onStatus(msg as StatusMsg);
      }
    };

    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === 4401) {
        o.onAuthFailed();
        return;
      }
      o.onConnection({ state: 'offline' });
      index = (index + 1) % GATEWAYS.length; // try the other gateway
      const delay = Math.min(10_000, 500 * 2 ** retries) + Math.random() * 300;
      retries++;
      timer = setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close(1000);
  };
}
