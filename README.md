# HookRelay

[![CI](https://github.com/aryaveer2411/hookrelay/actions/workflows/ci.yml/badge.svg)](https://github.com/aryaveer2411/hookrelay/actions/workflows/ci.yml)

A webhook ingestion and delivery relay. It accepts signed webhooks, persists them
transactionally, and delivers them to customer endpoints with at-least-once semantics,
per-endpoint rate limiting, optional strict ordering, tiered retries, a dead-letter queue,
manual replay, and a live dashboard.

---

## 1. Architecture

```
                       ┌──────────── nginx (:8080) ────────────┐
   senders ──POST──►   │  /in/*  /api/*  ──►  ingest           │
   browser ──WS───►    │  /ws            ──►  gateway1|gateway2│
                       │  /              ──►  dashboard (SPA)  │
                       └───────────────────────────────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                              ▼
              ┌──────────┐                   ┌──────────┐
              │  ingest  │                   │ gateway  │  WS fan-out
              └────┬─────┘                   └────▲─────┘
      verify HMAC  │  dedup (Redis + PG UNIQUE)   │ Redis pub/sub
      token bucket │  INSERT events + outbox      │ endpoint:<id>
                   ▼           (one transaction)  │
            ┌─────────────┐                       │
            │  Postgres   │                       │
            │ events      │                       │
            │ outbox      │                       │
            └──────┬──────┘                       │
                   │ SELECT ... FOR UPDATE SKIP LOCKED
                   ▼                              │
             ┌──────────┐   HashRing(endpoint_id) │
             │  relay   │──────────┐              │
             └──────────┘          ▼              │
                          ┌──────────────────┐    │
                          │ deliver.exchange │    │
                          │  deliver.p0..p7  │  quorum queues,
                          └────────┬─────────┘  single-active-consumer
                                   ▼            │
                          ┌─────────────────┐   │
                          │ worker-a / -b   │───┘  publishes status
                          └───┬─────────┬───┘
                 sign + POST  │         │ failure
                              ▼         ▼
                      target URL    retry.10s → 1m → 5m → 30m  →  dead.q
                                    (TTL + dead-letter back to deliver.exchange)
```

### Services

| Service | Path | Role |
|---|---|---|
| `ingest` | `apps/ingest` | Fastify. Webhook intake (`POST /in/:endpointId`), admin REST API, JWT login. |
| `relay` | `apps/relay` | Outbox poller. Reads unsent rows, routes by consistent hash, publishes with publisher confirms. |
| `worker` | `apps/worker` | AMQP consumer. Signs and delivers, classifies outcomes, drives retry tiers, SSRF-guarded egress. |
| `gateway` | `apps/gateway` | WebSocket fan-out for the dashboard. Subscribes to Redis `endpoint:<id>` channels. Two replicas. |
| `dashboard` | `apps/dashboard` | React SPA: endpoints, event history, attempt timeline, replay, live feed. |
| `mock-target` | `apps/mock-target` | Test receiver. Verifies outbound signatures, records deliveries, `POST /_mode` forces a status code. |
| `shared` | `packages/shared` | Hash ring, AMQP topology, partition registry, HMAC/AES-GCM helpers. |

### Why each piece exists

- **Transactional outbox** — `events` and `outbox` are inserted in one transaction. The broker is never the source of truth, so a RabbitMQ outage cannot lose an accepted webhook.
- **Consistent hash ring** (`packages/shared/src/ring.ts`) — MD5-based, 128 vnodes per partition. `endpoint_id → partition` is stable, so adding a partition moves only `1/N` of the keyspace.
- **Quorum queues + `x-single-active-consumer`** — exactly one worker consumes a partition at a time; the other is a hot standby that takes over on failure. This is what makes per-endpoint ordering possible across worker restarts.
- **Safe rebalance** (`apps/relay/src/relay.ts`) — when the ring changes, the relay holds an endpoint's new rows until its in-flight messages on the *old* partition finish. Without this, a rebalance would reorder an ordered endpoint.
- **Retry as TTL queues** — a failed attempt is republished to `retry.<tier>.x`; the message expires and dead-letters back to `deliver.exchange` with its original routing key. No timers in application code, no polling.

---

## 2. Delivery semantics

| Property | Guarantee |
|---|---|
| Intake | At-least-once from the sender; deduped on `(endpoint_id, external_id)`. |
| Delivery | At-least-once. A crash after the target responds but before the ack replays the attempt. |
| Ordering | Off by default. With `ordered: true`, one in-flight message per endpoint, retried in place. |
| Retries | 5 attempts max: 10s → 1m → 5m → 30m, then `dead.q`. |
| Non-retryable | 3xx, 4xx (except 408/429), and SSRF-blocked targets go straight to `dead`. |
| Replay | Only `dead` events. Resets to `pending` and re-inserts into `outbox`, audited in `replays`. |

**Dedup** is two-layer: Redis `SET NX` (24h) as a fast path, Postgres `UNIQUE (endpoint_id, external_id)` as the authority. If Redis is wiped mid-flight, Postgres still rejects the duplicate — this is what `scripts/scenarios/redis-flush.sh` proves.

**Ordering** is enforced at three levels: single-active-consumer per queue, one in-process promise chain per `endpointId` (`serial()` in `worker.ts`), and in-place retry instead of requeue (a requeued message would be overtaken).

---

## 3. Security

| Control | Implementation |
|---|---|
| Inbound auth | HMAC-SHA256 over `id.timestamp.body`, `webhook-signature: v1,<b64>`, constant-time compare, ±300s timestamp window. |
| Outbound auth | Same scheme, signed with the endpoint's outbound secret. |
| Secret storage | AES-256-GCM with `ENV_MASTER_KEY`, AAD bound to the endpoint id. Plaintext is returned exactly once at creation. |
| Admin auth | scrypt password → HS256 JWT (8h), plus a static bearer token for scripts. Both compared with `timingSafeEqual`. |
| Login abuse | Redis token bucket, 1 attempt/sec/IP. |
| Per-endpoint rate limit | Redis Lua token bucket, checked *after* signature verification so unauthenticated traffic cannot drain a tenant's tokens. |
| SSRF | Scheme allowlist, literal-IP check, and a custom `dns.lookup` that pins the connection to the validated address. Redirects disabled. Blocked targets are `dead`, never retried. |
| WebSocket | Origin allowlist, 5s auth deadline, per-IP connection cap, 4 KB frame cap, 1 MB backpressure cutoff, 25s ping / 2 missed pongs. |
| Transport | nginx sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; 1 MB body cap; `real_ip` from private ranges only. |

**Accepted trade-offs**, both deliberate:
1. If Redis is unreachable the rate limiter **fails open** (`ratelimit.ts`) — availability over enforcement.
2. Secrets are decrypted per request. See §7 for why that matters to the tail latency.

---

## 4. Running it

### Docker (full stack)

```bash
npm run env:init              # writes .env with fresh random secrets, prints the admin password
docker compose up -d --wait
open http://127.0.0.1:8080
```

`env:init` refuses to overwrite an existing `.env`; pass `--force` if you mean it. Set
`ADMIN_PASSWORD=...` to choose the dashboard password instead of getting a random one.

### Local dev

```bash
npm install
npm run dev                   # infra in Docker, all six services with hot reload
# dashboard: http://127.0.0.1:5173
```

`npm run dev:noworker` starts ingest + relay + mock-target only, so the chaos scripts can own the worker process.

### Tests

```bash
npm test                      # vitest: crypto, ratelimit, classify, ssrf (57 tests)
npm run typecheck --workspaces --if-present
```

### Smoke test

With the stack up, this proves the whole path works — intake, signature rejection,
dedup, relay, worker, delivery to the target, and the WebSocket live feed:

```bash
set -a; source .env; set +a
SMOKE_ADMIN_PASSWORD=<your password> npm run smoke
```

Omit `SMOKE_ADMIN_PASSWORD` to skip the login and live-feed checks. It is the same
script CI runs, so a local pass means the pipeline will pass.

---

## 5. Configuration

| Variable | Used by | Notes |
|---|---|---|
| `ENV_DB_URL` | all | Postgres connection string. |
| `ENV_RABBIT_URL` | relay, worker | AMQP URL. |
| `ENV_REDIS_URL` | ingest, worker, gateway, relay | Dedup, rate limits, partition registry, pub/sub. |
| `ENV_MASTER_KEY` | ingest, worker | **32 bytes, base64.** Encrypts endpoint secrets. |
| `ENV_JWT_SECRET` | ingest, gateway | ≥32 chars. Must match across both. |
| `ENV_ADMIN_TOKEN` | ingest | ≥24 chars. Static bearer token for scripts. |
| `ENV_ADMIN_PASSWORD_HASH` | ingest | `scrypt:<saltB64>:<hashB64>`. |
| `ENV_ALLOWED_ORIGINS` | gateway | Comma-separated WS origin allowlist. |
| `ENV_TRUST_PROXY` | ingest, gateway | `true` behind nginx, so `req.ip` is the real client. |
| `ENV_ALLOW_HTTP` | worker | `false` in production. `true` only for the mock target. |
| `ENV_SSRF_ALLOW_IPS` / `ENV_SSRF_ALLOW_HOSTS` | worker | Dev escape hatches for private addresses. |
| `ENV_WORKER_PREFETCH` | worker | AMQP QoS, default 20. |
| `ENV_WORKER_PRIMARY` | worker | e.g. `p0,p1,p2,p3`. Empty = all partitions. |
| `ENV_WORKER_STANDBY_DELAY_MS` | worker | Delay before joining non-primary queues as standby. Default 5000. |
| `ENV_MOCK_LATENCY_MS` / `ENV_MOCK_RECORD` | mock-target | Simulated latency; disable recording for benchmarks. |

> `.env.example` carries every key that has **no schema default** — those are the ones the
> apps refuse to start without. The rest of the table above is optional overrides; set them
> only when you want to change the default.

---

## 6. API

All `/api/*` routes require `Authorization: Bearer <jwt|static-token>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/login` | `{ password }` → `{ token, expiresInSec }`. |
| `POST` | `/api/endpoints` | Create. Returns `inboundSecret` and `outboundSecret` **once**. |
| `GET` | `/api/endpoints` | List (secret columns never returned). |
| `GET` `PATCH` `DELETE` | `/api/endpoints/:id` | Read / partial update / soft-delete. |
| `GET` | `/api/endpoints/:id/events` | Keyset pagination, 50/page, `?status=`, `?cursor=`. |
| `GET` | `/api/events/:id` | Event + full attempt and replay history. |
| `POST` | `/api/events/:id/replay` | Replay one dead event. |
| `POST` | `/api/events/replay` | Bulk replay, max 500 ids. |
| `POST` | `/in/:endpointId` | Webhook intake. Public, signature-authenticated. |

Intake responses: `202` accepted · `200 {duplicate:true}` · `400` bad headers/JSON · `401` bad signature or stale timestamp · `404` unknown endpoint · `410` disabled · `429` rate limited.

Send a test webhook:

```bash
node scripts/send-webhook.mjs <endpointId> <inboundSecret> "hello"
# WEBHOOK_ID=... replays the same id to exercise dedup
# MESSAGE_BYTES=100000 tests the 256 KB body cap
```

---

## 7. Findings

### Test system

| | |
|---|---|
| Machine | Apple M4, 16 GB RAM, macOS (Darwin 24.5.0) |
| Docker VM | 10 CPUs, 8,319,504,384 bytes (~7.75 GiB) |
| Stack under test | 1× ingest, 1× relay, 2× workers, 2× gateways, nginx, Postgres 16, Redis 7, RabbitMQ 3.13 |
| Load generator | k6 (`grafana/k6:latest`) **inside the same Docker VM** — it competes for the same 10 CPUs |
| Target | `mock-target` with `ENV_MOCK_LATENCY_MS=50` |

Harness: `bench/ingest.js` (100 endpoints, `bench/endpoints.json`), `scripts/bench-report.mjs` for end-to-end numbers straight from Postgres, `scripts/bench-watch.sh` for live queue depth.

### Run 1 — steady 1,000 rps for 2m

| Metric | Value |
|---|---|
| Offered / achieved | 1,000 rps / **877 rps** |
| Dropped iterations | 11,446 (VU pool exhausted at 2,000) |
| `http_req_duration` | avg 514 ms · p50 **3.3 ms** · p95 3.3 s · p99 **4.25 s** · max 4.87 s |
| Failures | 0.00% (5 of 108,558 — EOF / connection reset at ~109 s) |
| Threshold `p99<50ms` | ✗ crossed |
| E2E (Postgres) | p50 **167.8 ms** · p99 4,747 ms · drain after last request **0.0 s** · 0 dead |

### Run 2 — ramp 100 → 3,000 rps over 5m

| Metric | Value |
|---|---|
| Offered / achieved | up to 3,000 rps / **936 rps** |
| Dropped iterations | 181,897 (VU pool exhausted at 3,000) |
| `http_req_duration` | avg 2.0 s · p50 2.26 s · p95 3.58 s · p99 **4.26 s** · max 4.38 s |
| Failures | 0.00% (8 of 283,103) |
| E2E (Postgres) | 391,648 accepted / 391,648 delivered / **0 pending, 0 dead** · p50 221.9 ms · p99 5,187 ms · drain **0.5 s** |

### Runs 3 & 4 — worker prefetch sweep, 500 rps for 1m

| `ENV_WORKER_PREFETCH` | p50 | p95 | p99 | max | Failures |
|---|---|---|---|---|---|
| 1 | 0.99 ms | 7.03 ms | **57.8 ms** | 110.7 ms | 0 / 30,001 |
| 20 (default) | 0.99 ms | 9.03 ms | **66.5 ms** | 195.9 ms | 0 / 30,001 |
| 100 | — | — | — | — | not captured (loop interrupted during backlog drain) |

Both runs held exactly 500.0 rps with zero drops.

### What the numbers say

**1. The offered load was never actually offered — read the request accounting first.**
"Ramp to 3,000 rps" is a *target*, not traffic that reached the server. k6's arrival-rate
executors are open-model: they try to start N iterations per second whether or not earlier
ones finished, and each needs a free VU. When the pool is exhausted the surplus iterations
are **discarded before a socket is opened**. Every request is accounted for:

| | Run 1 (steady 1,000) | Run 2 (ramp → 3,000) |
|---|---|---|
| Scheduled by k6 | 1,000/s × 120 s = **120,000** | (100+3,000)/2 × 300 s = **465,000** |
| Sent (`http_reqs`) | 108,558 | 283,103 |
| Never sent (`dropped_iterations`) | 11,446 | 181,897 |
| Sum | **120,004** ✓ | **465,000** ✓ |
| Rejected with 429 | 0 | 0 |
| Failed (`http_req_failed`) | 4 | 8 |

So at the ramp's peak the ~2,100 rps gap between the 3,000 rps target and the ~900 rps
achieved was **dropped at the load generator** — not rate-limited, not queued server-side,
not absorbed by extra instances (there is exactly one `ingest` container). Zero 429s is
expected: the 100 bench endpoints are created at `ratePerSec: 1000` each and traffic is
spread randomly, so each saw ~9 rps against its own 1,000/s limit.

**2. Why the VU pool ran dry, and what 936 rps actually measures.**
Little's Law: sustaining 3,000 rps at a ~2 s response time needs 3,000 × 2 = **6,000**
concurrent VUs. The cap was 3,000, so k6 logged `Insufficient VUs, reached 3000 active VUs`
and dropped the rest. Past that point the test is no longer open-model at all — it degenerates
into a closed-loop test of 3,000 in-flight connections, where throughput is simply
`concurrency / latency`: 3,000 / ~3.2 s ≈ **937 rps**, which is what was measured.

**3. The ceiling is real, and this is the evidence — not the raw rps number.**
Run 1 capped VUs at 2,000; run 2 at 3,000. **50% more concurrency bought 6.7% more
throughput** (877 → 936 rps) while p50 rose from 3.3 ms to 2.26 s. Flat throughput with
latency growing in proportion to concurrency is the signature of a saturated resource. Had
the load generator been the limit, throughput would have tracked the VU cap. It did not.

**4. Backpressure surfaces as latency, not as errors.**
Failure rate stayed at 0.00% in every run — a growing queue, not a failing one. The handful
of EOF/connection-reset warnings at ~109 s in both runs is the accept queue overflowing at
2,000+ concurrent connections, which is correct behaviour at that point.

**Where this experiment stops.** It establishes *that* something saturates near 900 rps, not
*which component*. Two caveats stated plainly: k6 ran inside the same 10-CPU Docker VM as the
stack it measured, so ~900 rps is a **lower bound**; and no component was isolated. The
candidates are a single-process Node ingest, `pg.Pool({ max: 10 })` in `apps/ingest/src/db.ts`
(10 connections serving a path that makes 3 round trips including an fsync commit), and
nginx's `keepalive 64` to the upstream. Distinguishing them means raising one at a time and
watching whether throughput moves — see "Where the wins are" below.

**5. The delivery path was never the bottleneck.**
Run 2 delivered 391,648 of 391,648 events, zero dead, and drained **0.5 s** after the last request landed. Relay + RabbitMQ + 2 workers kept up with everything ingest could accept. Run 1's 2,109 `pending` were simply in flight when the report snapshot was taken; the 0.0 s drain confirms the queue was empty.

**6. Worker prefetch does not affect ingest latency — as designed.**
1 vs 20 differ by ~9 ms at p99, which is noise at this sample size. Prefetch governs the *delivery* path (worker → target); it cannot influence how fast ingest accepts a request. Sweeping it against an ingest-side threshold measured nothing. To actually characterise prefetch, measure `e2e_p99_ms` and drain time under a *saturated queue*, not `http_req_duration` at 500 rps.

**7. The `p99 < 50 ms` threshold is unrealistic for this design.**
Even at 500 rps — 55% of capacity, zero queueing — p99 was 58–67 ms against a p50 of 1 ms. A 60× p50→p99 spread means the tail is dominated by per-request synchronous work, not load. Each accepted webhook performs:

```
SELECT endpoints           (PG round trip 1)
AES-256-GCM open           (per request, no cache)
HMAC verify
Redis SET NX               (round trip)
BEGIN / INSERT events / INSERT outbox / COMMIT   (PG round trips 2–3, fsync)
Redis SET + PUBLISH        (round trip)
```

That is 3 Postgres round trips (one of them an fsync commit) and 2–3 Redis round trips per webhook, on one Node process. ~900 rps is about right for that. The tail is commit latency plus GC, and no threshold tuning will fix it.

### Where the wins are, in order

1. **Scale ingest horizontally.** `docker-compose.yml` runs a single `ingest` container and `infra/nginx.conf` has one server in the `ingest` upstream. It is stateless — Postgres and Redis hold all the state. 4 replicas behind the existing nginx upstream is the single largest available win and costs nothing architecturally.
2. **Cache the endpoint row and its decrypted inbound secret** in an in-process LRU (short TTL, invalidate on `PATCH`/`DELETE`). Removes one Postgres round trip *and* an AES-GCM open from every request — the two items on the hot path that do not need to be there.
3. **Batch the outbox write.** Micro-batch `INSERT events` + `INSERT outbox` across concurrent requests (~5 ms window) to amortise commit fsync, which is the most likely source of the p99 tail.
4. **Re-benchmark from outside the Docker VM.** k6 on the same 10 CPUs is competing with the stack it measures; the real ceiling is higher than 936 rps by an unmeasured margin.
5. **Then re-run the prefetch sweep** against `e2e_p99_ms` and drain time under saturation, where it can actually show a difference.

---

## 8. Continuous integration

`.github/workflows/ci.yml` runs on every push to any branch, on pull requests, and on
manual dispatch. A newer push to the same branch cancels the run in flight.

| Job | Time | What it proves |
|---|---|---|
| **Typecheck & unit tests** | ~1 min | `tsc --noEmit` across all 6 workspaces, 57 vitest tests against a real Redis service container, `npm audit --audit-level=high`. |
| **Secret guard** | seconds | No `.env*`, `bench/endpoints.json`, `logs/`, or `Endpoint id` file is tracked, and no tracked file has a long literal assigned to a `*SECRET*`/`*PASSWORD*`/`MASTER_KEY`/`ADMIN_TOKEN`/`PRIVATE_KEY` name. |
| **Stack smoke test** | ~3–6 min | Both Docker targets build, the full 11-container stack boots, and a signed webhook is delivered end to end. |

### Why the jobs are shaped this way

- **The unit tests need a `.env`.** Each app's `config.ts` parses the whole env schema at
  *import* time, and the vitest configs `loadEnv` from the repo root — so the suite cannot
  start without one. CI generates a throwaway one with `scripts/gen-env.mjs`.
- **`ratelimit.test.ts` needs a real Redis**, because the token bucket is a Lua script that
  runs inside Redis. It is a service container, not a mock.
- **Images are built with `docker/build-push-action` and a GHA layer cache**, then tagged
  `hookrelay-app` / `hookrelay-web` — the exact names `docker-compose.yml` declares. Compose
  finds them already present and skips rebuilding.
- **`compose up --wait` is not enough, and "did the edge answer?" is the wrong probe.**
  `--wait` only blocks until containers are *running*; the Node services have no healthcheck,
  so running never means listening. Worse, nginx starts answering immediately — with `502`s —
  while ingest is still booting, so any probe that accepts "some HTTP code came back" passes
  instantly and the failure surfaces later as a confusing 502 mid-test. Each readiness probe
  therefore checks the service itself: ingest must return **200** to an authenticated
  `/api/endpoints` (which also proves Postgres is reachable, since the handler queries it),
  each gateway must answer its own `/healthz` inside its container, and mock-target must
  accept a `/_mode` call before any delivery is attempted.
- **On failure the last 200 lines of every container log are dumped**, and the stack is torn
  down with `-v` either way so no volume leaks between runs.

### What CI does not run

The chaos scenarios in §9 need host-side worker processes and take several minutes each, so
they are left as a manual gate before a release rather than a per-push check:

```bash
npm run dev:noworker
./scripts/scenarios/run-all.sh
```

### Reproducing a CI failure locally

CI runs exactly what you can run yourself:

```bash
npm ci
ADMIN_PASSWORD=ci-password node scripts/gen-env.mjs --force   # careful: overwrites .env
npm run typecheck --workspaces --if-present
npm test
docker compose up -d --wait
set -a; source .env; set +a
SMOKE_ADMIN_PASSWORD=ci-password npm run smoke
```

> The badge at the top assumes the repo lives at `aryaveer2411/hookrelay`. Fix the two URLs
> if you push it somewhere else.

---

## 9. Failure scenarios

`scripts/scenarios/` drives fault injection under live load and then reconciles every accepted event id against Postgres and the mock target's receipt log.

| Script | Fault | Asserts |
|---|---|---|
| `worker-kill.sh` | `kill -9` mid-load, replacement worker starts | Unacked messages redelivered, 0 lost |
| `broker-restart.sh` | `docker compose restart rabbitmq` | Relay and worker reconnect, outbox drains, 0 lost |
| `redis-flush.sh` | `FLUSHALL` with 10% duplicate traffic | Postgres `UNIQUE` still catches dupes |
| `partition-failover.sh` | Kill the active consumer of `p0–p3` | Standby takes over, ordering preserved |
| `partition-rebalance.sh` | Add a partition while retries are pending | Safe-rebalance hold prevents reordering |

```bash
npm run dev:noworker          # scenarios start their own worker
./scripts/scenarios/run-all.sh
```

`scripts/reconcile.mjs` fails the run unless all of these are zero: `missing_from_database`, `still_pending`, `never_sent_to_queue`, `delivered_but_target_never_got_it`, `duplicate_event_rows`. `scripts/check-order.mjs` additionally asserts `out_of_order = 0` per endpoint for ordered runs.

---

## 10. Benchmark harness

```bash
set -a; source .env; set +a

COUNT=100 node scripts/bench-setup.mjs        # writes bench/endpoints.json (gitignored, has secrets)

SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose --profile bench run --rm k6 run \
  -e MODE=steady -e RATE=1000 -e DURATION=2m \
  --summary-export=results/steady-1000.json ingest.js
node scripts/bench-report.mjs                 # end-to-end truth from Postgres

./scripts/bench-watch.sh                      # outbox depth, queue depth, per-container CPU
```

`MODE=ramp -e PEAK=3000 -e RAMP=5m` runs the ramping-arrival-rate profile instead.

Set `ENV_MOCK_RECORD=false` when benchmarking — recording every delivery adds a Postgres insert per webhook to the target side.

> `bench/endpoints.json` contains live inbound secrets and is gitignored. Do not commit it, and do not paste benchmark setup output into shared docs.

---

## 11. Adding a partition

```bash
npm run partition:add -w apps/relay
```

Asserts the new queue **first**, then publishes the new list to Redis (`hookrelay:partitions`) and announces it on `partitions:changed`. Relays rebuild their hash ring, workers join the new queue. Nothing is ever routed to a queue that does not exist yet, and the relay's in-flight hold keeps ordered endpoints correct across the move.

---

## 12. Layout

```
apps/
  ingest/        Fastify: intake, admin API, auth
  relay/         outbox → RabbitMQ, hash-ring routing, add-partition CLI
  worker/        AMQP consumer, signed delivery, retries, SSRF guard
  gateway/       WebSocket fan-out (2 replicas)
  dashboard/     React SPA
  mock-target/   test receiver
packages/shared/ ring, topology, partitions, crypto
db/              schema.sql, mock.sql (auto-applied on first boot)
infra/           nginx.conf, rabbitmq.conf
scripts/
  gen-env.mjs    generate a .env with fresh secrets
  smoke.mjs      end-to-end check, also run by CI
  load*.mjs      load generators
  reconcile.mjs  0-loss assertion after a chaos run
  check-order.mjs per-endpoint ordering assertion
  bench-*.mjs    benchmark setup, reporting, live watch
  scenarios/     fault injection
bench/           k6 script + exported summaries
.github/workflows/ci.yml
```
