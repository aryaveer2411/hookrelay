# HookRelay MVP — Build Plan

A trimmed-down path through `PRD-java.md`. The goal is one signed webhook going in the
front door and coming out the other side, delivered to a real URL, with a retry if the
first try fails. Everything else is decoration and comes later.

## Scope

**In:** ingest (already built) → outbox → relay → RabbitMQ → worker → mock target, plus
retry and dead-lettering.

**Deliberately dropped for now:** consistent hashing + partitions, single-active-consumer,
ordered delivery mode, SSRF guards, Redis (dedup / rate limit / pub-sub), gateway +
dashboard, admin auth, the four-tier retry ladder. None of these reshape what is built
here — they bolt on afterwards.

**Schema:** no new migration needed. `V1__schema.sql` already has every table the MVP uses.

## Where the code stands today

| Phase (PRD) | State |
| --- | --- |
| 0–1 Infra + schema | done — compose with Postgres/Redis/RabbitMQ, Flyway V1, all 5 tables + indexes |
| 2 Shared logic | HMAC done (2.2). Hash ring (2.3) and full topology (2.4) deferred. Encryption (2.1) replaced by derived secrets |
| 3 Admin API | CRUD done. No global error handler (3.1), no admin auth (3.4) |
| 4 Intake | signature verify + transactional outbox done (4.1–4.3). No Redis dedup (4.4), rate limit (4.5) or status publish (4.6) |
| 5 Events / replay API | not started — read-only side branch, blocks nothing |
| 6 Mock target | not started |
| 7 Relay | **not started — the outbox is currently a dead end** |
| 8+ Worker, gateway | not started |

---

## Step 1 — Dependencies and Java version

- Add `spring-boot-starter-amqp` to `pom.xml`.
- Bump `<java.version>` from 17 to 21.

**Why:** the version bump is one line now, and it stops a full re-test later when the
worker wants virtual threads.

**Done when:** `./mvnw clean package` passes.

---

## Step 2 — Mock target (the fake customer)

A standalone `tools/MockTarget.java`, same style as the existing `tools/WebhookSender.java`:
an HTTP server that accepts POSTs, verifies the outbound signature, logs what it received,
and exposes a control route to force its response code (200 / 500).

**Why first:** there is nothing to deliver *to* without it, and nothing that fails *on
purpose* to test retries against. This is the test rig.

**Done when:** curling it in 200 mode and in 500 mode behaves differently.

---

## Step 3 — Queue topology (shrunk version of PRD task 2.4)

One Spring `@Configuration` class declaring:

| Thing | Name | Purpose |
| --- | --- | --- |
| Direct exchange | `deliver.exchange` | where the relay publishes |
| Queue | `deliver.p0` | the one and only partition for now |
| Binding | routing key `p0` | ties the two together |
| Retry queue | `retry.10s` | message TTL 10s, dead-letters back to `deliver.exchange` |
| Queue | `dead.q` | permanently failed messages |

Hardcode `"p0"` as a single constant. When consistent hashing arrives later, that constant
becomes `ring.partitionFor(endpointId)` and nothing else moves.

**The retry queue is the clever bit:** a failed message is published to `retry.10s`, sits
there doing nothing for 10 seconds, and RabbitMQ automatically returns it to
`deliver.exchange` when the TTL expires. No timer code in the application.

**Done when:** the app starts and all four queues are visible in the RabbitMQ UI at
`localhost:15673`.

---

## Step 4 — Relay (outbox → RabbitMQ)

A `@Scheduled` loop every 100 ms. In one transaction:

1. `SELECT ... FROM outbox o JOIN events e ... WHERE o.sent_at IS NULL ORDER BY o.id LIMIT 200 FOR UPDATE SKIP LOCKED`
2. Publish each row as a persistent message `{eventId, endpointId, attempt: 1}` to
   `deliver.exchange` with routing key `p0`.
3. Wait for **publisher confirms**, then `UPDATE outbox SET sent_at = now(), partition = 'p0'`
   for the confirmed rows only.
4. Commit.

Use `JdbcTemplate` here rather than JPA — `FOR UPDATE SKIP LOCKED` is exactly the SQL an
ORM hides. `SKIP LOCKED` is what lets two relay instances run side by side without ever
picking the same row.

**The one rule that matters:** mark `sent_at` *after* the broker confirms. Crashing before
marking republishes the row (harmless under at-least-once). Marking before confirming can
lose the event (not harmless).

**Done when:** sending a webhook gives the outbox row a `sent_at`, and a message appears in
`deliver.p0`.

---

## Step 5 — Worker (delivery)

A `@RabbitListener` on `deliver.p0` with **manual acknowledgement** and prefetch 20:

1. Load event + endpoint. If the event is no longer `pending`, ack and skip — this is what
   makes a redelivered duplicate harmless.
2. Sign the payload with `signWebhook(endpointId, "outbound", body, now)`.
3. POST to the endpoint's `target_url` with the timestamp and signature headers, 10 s
   timeout, redirects off. Use `java.net.http.HttpClient`; OkHttp is only needed for the
   SSRF DNS trick, which is out of MVP scope.
4. Insert the `delivery_attempts` row with status code and latency, then ack.

**Manual ack in plain English:** RabbitMQ is told "done" only *after* the result is saved to
Postgres. If the worker dies mid-delivery the message goes to someone else instead of
being lost.

**Done when:** mock-target in 200 mode receives a signed POST and the event flips to
`delivered`.

---

## Step 6 — Classify, retry, dead

One small pure function mapping a result to `SUCCESS` / `RETRY` / `DEAD`:

- 2xx → success → `status = delivered`
- 408, 429, 5xx, timeout, connection error → retry
- other 4xx, 3xx → dead (retrying a "400 bad request" forever helps nobody)

On a retry with attempts left (cap 5): record the attempt, republish with `attempt + 1` to
`retry.10s`, ack. On attempt 5 or a dead outcome: record the attempt, set `status = dead`,
copy to `dead.q`, ack.

**Done when:** mock-target in 500 mode produces 5 attempt rows roughly 10 s apart, then the
event goes `dead`.

---

## Step 7 — End-to-end smoke test

`WebhookSender` → ingest → outbox → relay → queue → worker → mock-target. Run once in 200
mode (delivered) and once in 500 mode (retries, then dead).

**Done when:** both paths work without touching the database by hand.

---

## Open decisions

**Where relay and worker run.** For the MVP, in the same Spring Boot app as ingest, behind
Spring profiles (`relay`, `worker`) so they can be split into separate processes later
without moving code. Simpler to debug, and splitting becomes a config change rather than a
rewrite.

**API contract drift.** The PRD's golden rule is keeping the HTTP contract identical to the
original TypeScript version so the existing React dashboard works unchanged. Current
deviations:

| Area | This codebase | PRD |
| --- | --- | --- |
| Intake route | `POST /api/event`, endpoint id in body | `POST /in/{endpointId}` |
| New event response | `201` | `202` |
| Duplicate response | `201` with stored row | `200` with `duplicate: true` |
| Disabled endpoint | `409` | `410` |

This blocks nothing in the MVP. But if the dashboard is going to be reused in PRD phase
11.4, fixing it now is five minutes and fixing it later is an afternoon.

---

## After the MVP

In roughly this order: consistent hash ring + real partitions (PRD 2.3, 2.4, 10.x), the
full four-tier retry ladder, SSRF protection (8.4), ordered delivery (8.5), Redis dedup /
rate limiting / status publishing (4.4–4.6), events + replay API (phase 5), admin auth
(3.4), then gateway and dashboard (phases 9 and 11).
