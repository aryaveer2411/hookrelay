import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const COUNT = Number(process.env.COUNT ?? 100);
const TOKEN = process.env.ENV_ADMIN_TOKEN;
if (!TOKEN) { console.error('run: set -a; source .env; set +a'); process.exit(1); }

const out = [];
for (let i = 0; i < COUNT; i++) {
  const res = await fetch(`${BASE}/api/endpoints`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `bench-${i}`, targetUrl: 'http://mock-target:4000/hook', ratePerSec: 1000 }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const { endpoint, inboundSecret } = await res.json();
  out.push({ id: endpoint.id, secret: inboundSecret });
}
writeFileSync('bench/endpoints.json', JSON.stringify(out));
console.log(`created ${COUNT} endpoints → bench/endpoints.json (this file has secrets; it's gitignored)`);
