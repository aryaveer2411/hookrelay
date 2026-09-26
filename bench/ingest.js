import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check } from 'k6';

const endpoints = JSON.parse(open('./endpoints.json'));
const BASE = __ENV.BASE || 'http://web';
const MODE = __ENV.MODE || 'steady';

const scenarios = {
  // Fixed speed: RATE requests per second for DURATION
  steady: {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.RATE || 1000),
    timeUnit: '1s',
    duration: __ENV.DURATION || '2m',
    preAllocatedVUs: 200,
    maxVUs: 2000,
  },
  // Speed up from 100/s to PEAK/s over RAMP, to find the ceiling
  ramp: {
    executor: 'ramping-arrival-rate',
    startRate: 100,
    timeUnit: '1s',
    preAllocatedVUs: 300,
    maxVUs: 3000,
    stages: [{ target: Number(__ENV.PEAK || 3000), duration: __ENV.RAMP || '5m' }],
  },
};

export const options = {
  discardResponseBodies: true,
  scenarios: { [MODE]: scenarios[MODE] },
  thresholds: {
    'http_req_duration{status:202}': ['p(99)<50'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
  const id = `bench_${__VU}_${__ITER}_${Date.now()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 'bench', vu: __VU, iter: __ITER });
  const sig = crypto.hmac('sha256', encoding.b64decode(ep.secret), `${id}.${ts}.${body}`, 'base64');
  const res = http.post(`${BASE}/in/${ep.id}`, body, {
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${sig}`,
    },
  });
  check(res, { 'accepted (202)': (r) => r.status === 202 });
}
