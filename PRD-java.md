# HookRelay (Java Edition) — Product Requirements & Build Plan

This document is theory only. It explains **what** to build, **why** each piece exists, and **in what order** to build it. Each task is one small, finishable thing. Do not skip ahead: every phase depends on the one before it.

---

## Part A — Understand the product first

### A.1 What is a webhook?
A webhook is an HTTP POST that one system sends to another when something happens ("payment succeeded", "order shipped"). The sender pushes data to you instead of you asking for it.

### A.2 What problem does HookRelay solve?
Delivering webhooks reliably is hard. The receiving server may be down, slow, or return errors. Senders may send the same webhook twice. Some customers need events delivered in exact order. Attackers may try to send fake webhooks or trick your server into calling internal addresses.

HookRelay sits in the middle:
1. **Accepts** webhooks from senders, checks they are genuine, and stores them safely.
2. **Delivers** them to customer URLs, retrying on failure, never losing one.
3. **Shows** everything live on a dashboard, and lets an admin replay failed ones.

### A.3 Vocabulary you must know
- **Endpoint** — one registered destination (a customer's URL) plus its settings and secrets.
- **Event** — one received webhook, tied to an endpoint.
- **Ingest** — receiving and storing a webhook.
- **Delivery** — sending the stored event to the endpoint's target URL.
- **Attempt** — one try at delivery. An event can have many attempts.
- **HMAC signature** — a hash of the message computed with a shared secret. Proves the message came from someone who knows the secret and was not modified.
- **Idempotency / dedup** — receiving the same webhook twice must store it only once.
- **At-least-once delivery** — every event is delivered one or more times. Never zero. Duplicates are possible, loss is not.
- **Message broker (RabbitMQ)** — a server that holds messages in queues so producers and consumers do not need to be online at the same time.
- **Transactional outbox** — writing the event and a "please send this" row in the same database transaction, so the event can never be saved without also being scheduled for delivery.
- **Dead-letter queue (DLQ)** — where messages go after they permanently fail.
- **Partition** — one of several queues; work is split across them.
- **Consistent hashing** — a way of mapping each endpoint to a partition so that adding a partition moves only a small share of endpoints.
- **Pub/Sub** — publish/subscribe messaging; used here (Redis) to push live status updates.
- **WebSocket** — a long-lived two-way connection between browser and server, for live updates.
- **SSRF (Server-Side Request Forgery)** — an attack where someone makes your server call an internal address (like a cloud metadata service or your database).

### A.4 The six services and how data flows
1. **ingest** — HTTP API. Receives webhooks, verifies them, writes to Postgres. Also hosts the admin API (endpoints, events, replay, login).
2. **relay** — background process. Reads unsent rows from the outbox table and publishes them to RabbitMQ.
3. **worker** — background process. Takes messages from RabbitMQ, calls the customer's URL, records the result, schedules retries.
4. **gateway** — WebSocket server. Forwards live status updates from Redis to browsers.
5. **dashboard** — web UI for the admin. (You can reuse the existing React app.)
6. **mock-target** — a fake customer server for testing deliveries.

Supporting infrastructure: **Postgres** (source of truth), **Redis** (dedup cache, rate limits, pub/sub, partition list), **RabbitMQ** (delivery queues), **nginx** (single front door).

Flow of one webhook: sender → nginx → ingest (verify, dedup, save event + outbox row) → relay (outbox → RabbitMQ) → worker (sign, POST to target) → success recorded, or retry later, or dead → status pushed via Redis → gateway → dashboard.

### A.5 Goals
- No accepted webhook is ever lost, even if RabbitMQ, Redis, or a worker crashes.
- Duplicates from senders are stored once.
- Failed deliveries retry automatically with growing delays, then go to dead.
- Optional strict ordering per endpoint.
- Secrets are encrypted at rest; all auth checks are constant-time.
- Outbound calls cannot be abused to reach private networks.
- Admin sees everything live.

### A.6 Non-goals (for now)
- Multi-tenant user accounts (one admin only).
- Exactly-once delivery (impossible in general; we do at-least-once).
- Payload transformation or filtering.

---

## Part B — Technology choices for Java (and why)

- **Java 21 (LTS)** — modern language features, and *virtual threads*, which make blocking I/O code cheap and simple.
- **Spring Boot 3** — the standard Java framework. Gives you web server, config, database access, dependency injection, health checks.
- **Maven multi-module project** — one repository, one module per service, plus a shared module. Maven is the most beginner-friendly build tool with the most tutorials.
- **Postgres + Flyway** — Flyway runs versioned SQL migration files at startup so the schema is always correct and tracked.
- **Spring JDBC (JdbcTemplate)** — write plain SQL instead of an ORM. This project relies on precise SQL (row locking, `ON CONFLICT`), and an ORM like Hibernate would hide it. Learning plain SQL here is a benefit.
- **HikariCP** — database connection pool (comes with Spring Boot).
- **Spring Data Redis (Lettuce client)** — Redis access, including running Lua scripts and pub/sub.
- **Spring AMQP** — RabbitMQ client with publisher confirms and manual acknowledgements.
- **Spring WebSocket** — for the gateway.
- **OkHttp** — HTTP client for outbound delivery. Chosen because it lets you plug in a custom DNS resolver, which is required for SSRF protection. Java's built-in client does not allow this.
- **Nimbus JOSE or JJWT** — JSON Web Token library.
- **Bouncy Castle** — for the scrypt password hash (Java has no scrypt built in).
- **Jakarta Bean Validation** — input validation (the Java equivalent of zod).
- **JUnit 5 + AssertJ + Testcontainers** — tests. Testcontainers starts real Postgres/Redis/RabbitMQ in Docker for tests.
- **Docker + Docker Compose** — run everything locally with one command.

**Golden rule:** keep the HTTP API, JSON shapes, header names, database schema, and queue names **identical** to the existing TypeScript version. Then the existing dashboard, smoke test, and chaos scripts can test your Java version unchanged. They become your answer key.

---

## Part C — Build plan (phase by phase, task by task)

Each task lists: **Goal**, **Learn**, **Done when**. Commit after each task.

---

### Phase 0 — Setup your machine and project

**Task 0.1 — Install tools**
- Goal: JDK 21, Maven, Docker Desktop, Git, an IDE (IntelliJ IDEA Community), and a REST client (Postman, Bruno, or curl).
- Learn: what JDK vs JRE is; what Maven does (downloads libraries, compiles, runs tests, packages jars).
- Done when: Java, Maven, and Docker all print versions from a terminal.

**Task 0.2 — Learn the minimum Java + Spring Boot**
- Goal: build a throwaway "hello" Spring Boot app with one GET route.
- Learn: classes, records, interfaces, exceptions, collections, `Optional`; Spring concepts: application class, controller, service, dependency injection, `application.yml`, profiles.
- Done when: browser shows your hello response.

**Task 0.3 — Create the multi-module skeleton**
- Goal: a parent project with modules: `shared`, `ingest`, `relay`, `worker`, `gateway`, `mock-target`.
- Learn: parent POM, dependency management, how one module depends on another.
- Done when: the whole project builds with one command, each service starts and does nothing.

**Task 0.4 — Configuration from environment**
- Goal: each service reads settings (database URL, Redis URL, secrets) from environment variables, fails to start if a required one is missing, and never prints secrets.
- Learn: typed configuration properties, validation on startup, `.env` file, why secrets never go in git.
- Done when: starting without a required variable fails with a clear message.

---

### Phase 1 — Infrastructure and database

**Task 1.1 — Docker Compose for infrastructure only**
- Goal: Postgres 16, Redis 7, RabbitMQ 3.13 (with management UI) running in containers, with health checks and persistent volumes.
- Learn: images, containers, ports, volumes, health checks.
- Done when: you can connect to Postgres with a DB tool, open the RabbitMQ UI, and ping Redis.

**Task 1.2 — Database schema via Flyway**
- Goal: five tables, created by a migration:
  - **endpoints** — id, name, target URL, encrypted inbound secret, encrypted outbound secret, rate per second, ordered flag, disabled-at time, created-at time.
  - **events** — id, endpoint id, external id (the sender's webhook id), JSON payload, status (pending / delivered / dead), received-at. Unique on (endpoint id, external id) — this is the final dedup guard.
  - **outbox** — id (auto-increment), event id, sent-at (empty until relayed), partition.
  - **delivery_attempts** — event id, attempt number, HTTP status code, error text, latency, time.
  - **replays** — event id, who replayed it, time.
- Indexes: unsent outbox rows; attempts by event; events by endpoint + time (for paging); pending events by endpoint; outbox by event.
- Learn: primary keys, foreign keys, unique constraints, partial indexes, why JSONB, why UUIDs.
- Done when: ingest starts, Flyway applies the migration, all tables exist.

---

### Phase 2 — Shared module (pure logic, no servers)

Build these first because every service needs them, and they are easy to unit-test.

**Task 2.1 — Secret encryption (AES-256-GCM)**
- Goal: functions to *seal* (encrypt) and *open* (decrypt) an endpoint secret with a 32-byte master key. Stored format: 12-byte IV, then 16-byte auth tag, then ciphertext. The endpoint id is used as "additional authenticated data" so a secret copied to a different endpoint row will fail to decrypt.
- Learn: symmetric encryption, why GCM (it detects tampering), why a fresh random IV every time, what AAD is.
- Note: Java's GCM puts the tag at the *end* of the ciphertext. You must rearrange bytes to match the stored format, or the TypeScript and Java versions will not read each other's data.
- Done when: tests prove round-trip works, wrong key fails, wrong endpoint id fails, tampered byte fails.

**Task 2.2 — HMAC signing and verification**
- Goal: sign a message as HMAC-SHA256 over "id.timestamp.body", output as "v1," plus base64. Verify a header that may contain several space-separated signatures; accept if any matches.
- Learn: HMAC, why compare signatures in constant time (timing attacks), why sign raw bytes, not re-serialized JSON.
- Done when: tests cover valid, wrong secret, modified body, wrong version prefix, multiple signatures.

**Task 2.3 — Consistent hash ring**
- Goal: given a list of partitions (p0..p7), place 128 virtual points per partition on a ring using the first 4 bytes of MD5 (as an unsigned number). To find a key's partition, hash the key and pick the first point clockwise (binary search).
- Learn: why plain "hash mod N" is bad (adding one partition reshuffles almost everything); virtual nodes for even spread; unsigned integers in Java (Java has no unsigned int — use long).
- Done when: tests show the same key always maps the same way, distribution is roughly even, and adding a 9th partition moves only about 1/9 of keys. Bonus: same answers as the TypeScript ring for sample keys.

**Task 2.4 — Queue topology definitions**
- Goal: one place that defines names and settings:
  - Direct exchange "deliver.exchange".
  - Partition queues "deliver.p0" … "deliver.p7", each a *quorum* queue with *single-active-consumer*, bound by routing key p0..p7.
  - Retry tiers: 10s, 1m, 5m, 30m. Each tier is a fanout exchange plus a queue with a message TTL whose dead-letter target is "deliver.exchange". A message waits out its TTL, then automatically returns to its original partition.
  - "dead.q" for permanently failed messages.
  - Max attempts = 5.
- Learn: exchanges vs queues vs bindings, routing keys, quorum queues (replicated, durable), TTL + dead-lettering, single-active-consumer (only one consumer receives at a time; others wait as hot standby).
- Done when: a small test app declares everything and you can see it in the RabbitMQ UI.

---

### Phase 3 — Ingest service, part 1: admin API

**Task 3.1 — Health endpoint and error handling**
- Goal: a health route; one global error handler that returns consistent JSON errors and never leaks stack traces.
- Learn: controller advice / exception handlers, HTTP status codes.
- Done when: bad routes and thrown exceptions return clean JSON.

**Task 3.2 — Create endpoint**
- Goal: admin posts name, target URL, rate, ordered flag. Server generates two random 32-byte secrets (inbound and outbound), encrypts both, stores the row, and returns the plaintext secrets **once** in the response.
- Learn: secure random generation, input validation, why you show secrets only once.
- Done when: row exists, secret columns are unreadable ciphertext, response includes secrets.

**Task 3.3 — List, get, update, soft-delete endpoints**
- Goal: list and get never return secret columns. Update is partial (only fields sent change). Delete sets disabled-at instead of removing the row.
- Learn: DTOs vs database rows, partial updates, why soft delete (events still reference the endpoint).
- Done when: all four operations work and no response contains a secret.

**Task 3.4 — Admin authentication**
- Goal: every admin route requires a Bearer token. Two kinds accepted:
  1. A static admin token (for scripts) — compare hashes in constant time.
  2. A JWT (HS256, 8-hour expiry, role = admin) from the login route.
- Login route: password is checked against a stored scrypt hash ("scrypt:salt:hash" format). Returns token and expiry.
- Learn: authentication vs authorization, JWT structure and why to pin the algorithm, password hashing (why scrypt, never plain SHA), servlet filters / Spring Security basics.
- Done when: no token = 401, bad token = 401, both good token types work.

---

### Phase 4 — Ingest service, part 2: webhook intake (the heart)

Build the intake route in layers. Test after each layer.

**Task 4.1 — Accept raw body and validate headers**
- Goal: route POST to /in/{endpointId}. Read the body as **raw bytes** (not auto-parsed JSON — you need exact bytes for the signature). Require headers webhook-id, webhook-timestamp (digits), webhook-signature. Body cap 256 KB.
- Responses: invalid endpoint id format → 404; missing headers → 400.
- Learn: why framework JSON parsing breaks signatures; request size limits.
- Done when: bad inputs return correct codes.

**Task 4.2 — Look up endpoint, check timestamp, verify signature**
- Order matters:
  1. Load endpoint. Missing → 404. Disabled → 410.
  2. Timestamp more than 300 seconds from now → 401 (blocks replay of old captured requests).
  3. Decrypt inbound secret, verify signature → 401 if wrong.
- Learn: replay attacks, why reject early and cheaply.
- Done when: a correctly signed request passes; any change to body, id, or timestamp fails.

**Task 4.3 — Store event + outbox in one transaction**
- Goal: parse body as JSON (invalid → 400). In one transaction: insert event with status pending, using "on conflict do nothing" on (endpoint id, external id); if a row was inserted, insert an outbox row; commit. Return 202 with the event id.
- If the insert hit the conflict (duplicate): roll back, look up the existing event id, return 200 with duplicate = true.
- Learn: transactions, atomicity, the transactional outbox pattern (why you must NOT publish to RabbitMQ directly here — if RabbitMQ is down or the app crashes between DB write and publish, the event is lost or orphaned).
- Done when: sending the same webhook twice creates one event and one outbox row.

**Task 4.4 — Fast dedup in Redis**
- Goal: before the DB write, try to set a Redis key "idem:{endpoint}:{webhookId}" = pending, only-if-absent, 24-hour expiry.
  - If you got the key: continue; after commit, overwrite it with the event id.
  - If key exists with a real event id: return 200 duplicate immediately (no DB work).
  - If key says pending: another request is saving it right now — let Postgres decide.
  - If the DB write fails: delete the key so the sender's retry is not treated as a duplicate.
  - If Redis is down: log a warning and rely on Postgres only.
- Learn: two-layer dedup (Redis is fast but can be wiped; Postgres unique constraint is the authority), race conditions.
- Done when: duplicates are fast, and after wiping Redis duplicates are still rejected.

**Task 4.5 — Per-endpoint rate limit (token bucket)**
- Goal: each endpoint gets N tokens per second (its rate setting). Each request takes one. Empty bucket → 429 with Retry-After header. Implemented as a Lua script inside Redis so check-and-decrement is atomic. Uses Redis server time, not app time.
- Placement: **after** signature verification, so strangers cannot drain a real customer's tokens.
- Trade-off: if Redis is unreachable, **allow** the request (fail open) — availability over enforcement. Write this decision down.
- Also: apply the same limiter to login at 1 attempt/second per IP.
- Learn: token bucket algorithm, why atomic (two app instances racing), fail-open vs fail-closed.
- Done when: a burst above the rate gets 429s; killing Redis does not break intake.

**Task 4.6 — Announce "received"**
- Goal: after commit, publish a small JSON status message to Redis channel "endpoint:{id}" (event id, outcome = received, attempt 0, time). Fire-and-forget; failure must not fail the request.
- Done when: a Redis CLI subscriber sees the message.

---

### Phase 5 — Ingest service, part 3: events and replay API

**Task 5.1 — Event history with keyset pagination**
- Goal: list events for an endpoint, newest first, 50 per page, optional status filter. The cursor is an opaque string encoding (received-at, id) of the last row. Next page = rows strictly "older" than the cursor.
- Learn: why keyset pagination beats offset pagination (stable and fast on big tables), why tie-break on id.
- Done when: paging through 500 events returns each exactly once.

**Task 5.2 — Event detail**
- Goal: one event plus all attempts in order plus replay history.
- Done when: an event's full timeline is visible.

**Task 5.3 — Replay dead events**
- Goal: single and bulk (max 500 ids). In one transaction: set status back to pending only for events that are currently dead, insert replay audit rows (who replayed), insert new outbox rows. Then announce "replayed" via Redis.
- Learn: why only dead events (replaying pending ones would create duplicate in-flight deliveries), audit trails.
- Done when: a dead event goes back through delivery and the replay is recorded.

---

### Phase 6 — Mock target (test receiver)

**Task 6.1 — Build mock-target**
- Goal: a tiny service that receives deliveries, verifies the outbound signature, records what it got, optional artificial latency, and a control route to force a response code (for example "return 500 for the next requests").
- Learn: you need a controllable receiver to test retries and dead-lettering.
- Done when: you can switch it between 200, 500, and 400 modes on demand.

---

### Phase 7 — Relay service (outbox → RabbitMQ)

**Task 7.1 — Poll the outbox safely**
- Goal: a loop that, in a transaction, selects up to 200 unsent outbox rows (joined with event and endpoint to get endpoint id and ordered flag), in id order, using **FOR UPDATE SKIP LOCKED**. Sleep 100 ms when idle.
- Learn: row locking; SKIP LOCKED lets several relay instances run without picking the same rows or blocking each other.
- Done when: rows are selected and logged; two relays never pick the same row.

**Task 7.2 — Publish with confirms, then mark sent**
- Goal: for each row, pick its partition from the hash ring (by endpoint id), publish a persistent message {eventId, endpointId, attempt 1, ordered} with message id = event id, "mandatory" flag on. Wait for **publisher confirms**. Only rows that were confirmed and not returned are marked sent (sent-at = now, partition recorded). Then commit.
- Learn: publisher confirms (broker says "I've safely stored it"), mandatory + returns (message had no queue), why mark sent **after** confirm (crash before marking = duplicate publish, which is fine under at-least-once; marking before = possible loss, which is not).
- Done when: events flow into partition queues and outbox rows get sent-at.

**Task 7.3 — Reconnect and graceful shutdown**
- Goal: if RabbitMQ disconnects, wait 2 seconds and reconnect, re-declaring the topology. On shutdown signal, finish the current batch and exit.
- Done when: restarting RabbitMQ while the relay runs causes no lost events.

---

### Phase 8 — Worker service (delivery)

**Task 8.1 — Consume and deliver (happy path)**
- Goal: consume from all partition queues with **manual acknowledgement** and a prefetch (default 20). For each message: load event + endpoint; if event is no longer pending, ack and skip. Otherwise decrypt outbound secret, sign the body, POST to target URL with webhook-id, webhook-timestamp, webhook-signature headers, 10-second timeouts, no redirects. On success: in one transaction, insert attempt row and set status delivered. Then ack.
- Learn: manual ack (ack only after work is saved — a crash before ack means RabbitMQ redelivers), prefetch, why "is it still pending?" check makes redelivery harmless.
- Tip: use virtual threads so many deliveries can wait on the network at once without a huge thread pool.
- Done when: mock-target receives signed deliveries and events become delivered.

**Task 8.2 — Classify outcomes**
- Goal: one pure function mapping result → success / retry / dead:
  - 2xx → success.
  - 408, 429, 5xx, network error, timeout → retry.
  - Other 4xx, 3xx → dead (retrying won't help).
  - SSRF-blocked → dead (never retry).
- Done when: unit tests cover every branch.

**Task 8.3 — Retry tiers and dead-letter**
- Goal: on retry-able failure with attempts left: record the attempt, publish the message with attempt + 1 to the retry exchange for the tier matching the failed attempt number, keeping the original routing key, then ack. After attempt 5, or on dead outcome: record attempt, set status dead, publish copy to dead.q, ack.
- Unexpected internal error (e.g. DB down): negative-ack with requeue after a 1-second pause.
- Learn: no timers in application code — RabbitMQ TTL does the waiting; the message comes back to the same partition on its own.
- Done when: mock-target in 500 mode produces attempts at roughly 0s, 10s, 1m10s, 6m10s, 36m10s, then dead.

**Task 8.4 — SSRF protection**
- Goal: before any delivery:
  1. Only https allowed (http only when a dev flag is on).
  2. If the URL host is a literal IP, it must be a public unicast address.
  3. For hostnames, use a custom DNS resolver in OkHttp that resolves the name, rejects it if **any** resolved address is private/loopback/link-local/multicast/reserved, and makes the client connect to exactly those checked addresses (prevents DNS rebinding — the name resolving to a different IP between check and connect).
  4. Redirects disabled.
  5. Dev escape hatches: allow-listed IPs and hostnames (so mock-target on a private Docker network works).
- Learn: private IP ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, IPv6 equivalents, IPv4-mapped IPv6), DNS rebinding, cloud metadata attacks.
- Done when: tests prove localhost, 127.0.0.1, 10.x, 169.254.169.254, IPv6 loopback, and tricky forms like decimal IPs are all blocked.

**Task 8.5 — Ordered delivery mode**
- Goal: for endpoints with ordered = true, messages for that endpoint must be processed strictly one at a time, and a failing message must **retry in place** (wait the tier delay inside the worker, then try again) instead of going to a retry queue — otherwise the next message would overtake it.
- Design: keep a map of endpoint id → a single "lane" (a serial queue of tasks). Ordered messages for the same endpoint go into the same lane; unordered messages run freely in parallel. Never nack an ordered message on internal error — pause and retry the same one.
- Three layers make ordering hold: single-active-consumer per queue, one lane per endpoint in the worker, in-place retry.
- Learn: why ordering and parallelism fight each other; head-of-line blocking is the accepted cost.
- Done when: a test sending numbered events to an ordered endpoint, with forced failures mid-way, receives them in exact order.

**Task 8.6 — Primary/standby and graceful shutdown**
- Goal: a worker can be told its primary partitions (e.g. p0–p3). It subscribes to those first, waits ~5 seconds, then subscribes to all others as standby. Because of single-active-consumer, the other worker stays active on its partitions and this one only takes over if that worker dies. On shutdown: cancel consumers, wait for in-flight messages to finish, then close. Ordered retries that are waiting should stop and leave the message unacked (RabbitMQ returns it, still in order).
- Done when: running two workers splits partitions; killing one makes the other take over within seconds, with no loss.

**Task 8.7 — Publish delivery status**
- Goal: after each outcome (delivered / retrying / dead), publish a status message to Redis channel "endpoint:{id}".
- Done when: a Redis subscriber sees each attempt live.

---

### Phase 9 — Gateway service (live WebSocket feed)

**Task 9.1 — WebSocket server with auth handshake**
- Goal: accept upgrades only on /ws, only from allowed Origins, max N connections per IP. The client's first message must be an auth message with a valid admin JWT within 5 seconds, or the connection is closed.
- Learn: WebSocket upgrade, Origin checks (browsers do not enforce CORS on WebSockets — you must), why authenticate over the socket instead of in the URL (URLs get logged).
- Done when: unauthenticated or wrong-origin clients are rejected.

**Task 9.2 — Subscribe / unsubscribe to endpoints**
- Goal: authenticated clients send subscribe/unsubscribe for endpoint ids (max 50 each). The gateway keeps "rooms": the first watcher of an endpoint makes the gateway subscribe to that Redis channel; the last one leaving unsubscribes. Incoming Redis messages are forwarded to everyone in the room.
- Done when: the dashboard sees received → retrying → delivered live.

**Task 9.3 — Protect the gateway**
- Goal: 4 KB max incoming frame, text only, strict message validation; drop a client whose outgoing buffer exceeds 1 MB (too slow); ping every 25 seconds, disconnect after 2 missed pongs; on shutdown tell clients to reconnect elsewhere; a /healthz route.
- Learn: backpressure, heartbeat, resource exhaustion attacks.
- Done when: a slow or silent client is dropped, and two gateway replicas both work behind nginx.

---

### Phase 10 — Dynamic partitions and safe rebalance (advanced)

**Task 10.1 — Partition list in Redis**
- Goal: the partition list is stored in Redis (key "hookrelay:partitions"), with a change announcement on channel "partitions:changed". Relay and worker load it at start, react to announcements, and also re-check every 30 seconds in case one was missed. If Redis was wiped, write back the last known list.
- Done when: changing the list makes relays rebuild the ring and workers join new queues.

**Task 10.2 — Add-partition command**
- Goal: a command-line tool that (1) declares the new queue first, then (2) saves the new list, then (3) announces it. Order matters: nothing may be routed to a queue that doesn't exist yet.
- Done when: running it adds p8 and new traffic reaches it.

**Task 10.3 — Safe rebalance in the relay**
- Goal: when the ring changes, an endpoint may move from p3 to p8. If it still has in-flight messages on p3 (sent but still pending), the relay must **hold** that endpoint's new rows until the old ones finish. Otherwise p8 could deliver newer events before p3 finishes older ones — breaking order.
- Learn: why moving work between queues is the hardest part of ordered systems.
- Done when: adding a partition while ordered retries are pending does not reorder anything.

---

### Phase 11 — Put it all together

**Task 11.1 — Dockerize every service**
- Goal: one multi-stage Dockerfile (build with Maven, run on a small JRE image, non-root user). Health checks that test the service itself, not just "container running".
- Done when: every service image builds and starts.

**Task 11.2 — nginx as the front door**
- Goal: route /in and /api to ingest, /ws to both gateways, / to the dashboard. Add security headers (nosniff, frame deny, no-referrer), 1 MB body cap, trust client IP forwarding only from private ranges, WebSocket upgrade support.
- Done when: the whole system works through a single port.

**Task 11.3 — Full Docker Compose stack**
- Goal: all 11 containers (infra, ingest, relay, 2 workers, 2 gateways, mock-target, dashboard, nginx) with correct startup order and a script that generates a .env with fresh random secrets.
- Done when: one command brings up everything and a signed webhook is delivered end to end.

**Task 11.4 — Connect the dashboard**
- Goal: reuse the existing React dashboard pointed at your Java services. If your API matches the original contract, it works with no changes. Any breakage = your API differs; fix the Java side.
- Done when: login, endpoint list, event history, event timeline, replay, and live feed all work.

---

### Phase 12 — Testing and proof

**Task 12.1 — Unit tests**
- Cover: crypto, signature, hash ring, classify, SSRF checks, cursor encoding.

**Task 12.2 — Integration tests with Testcontainers**
- Cover: rate limiter against real Redis, intake against real Postgres (dedup, transaction), relay + worker against real RabbitMQ (retry tiers with short TTLs for speed).

**Task 12.3 — Smoke test**
- Run the existing smoke script against your stack: intake, bad signature rejection, dedup, delivery, live feed.
- Done when: it passes unchanged.

**Task 12.4 — Chaos scenarios**
- Run each fault under live load, then reconcile every accepted event id against Postgres and the mock-target's log:
  - Kill a worker hard mid-load → unacked messages redelivered, zero lost.
  - Restart RabbitMQ → relay and worker reconnect, outbox drains, zero lost.
  - Flush Redis with 10% duplicate traffic → Postgres still rejects duplicates.
  - Kill the active consumer of some partitions → standby takes over, order preserved.
  - Add a partition during pending retries → no reordering.
- Done when: missing, stuck, never-queued, delivered-but-not-received, duplicate, and out-of-order counts are all zero.

**Task 12.5 — Continuous integration (GitHub Actions)**
- Jobs: build + unit/integration tests; secret guard (no .env or secret-looking literals committed); full-stack smoke test in Docker with dumped logs on failure.

---

### Phase 13 — Performance (only after everything works)

**Task 13.1 — Benchmark**
- Use k6 at steady 1,000 rps and a ramp to 3,000 rps; measure request latency and end-to-end delivery time from Postgres. Run the load generator outside the Docker VM if possible.
- Learn: open vs closed load models, Little's Law, why "dropped iterations" means the load generator ran out of capacity, not your server.

**Task 13.2 — Improve, one change at a time, re-measuring each**
1. Run several ingest replicas behind nginx (it is stateless).
2. Tune the connection pool size.
3. Cache endpoint rows and decrypted inbound secrets in memory with a short expiry, invalidated on update/delete.
4. Micro-batch event + outbox inserts across concurrent requests to share commit cost.
5. Compare virtual threads vs a classic thread pool.
- Done when: you can explain which component is the bottleneck and prove it with numbers.

---

## Part D — Security checklist (verify before calling it done)

- Inbound signatures verified in constant time with a ±5 minute timestamp window.
- Outbound deliveries signed with a separate per-endpoint secret.
- Secrets encrypted at rest with AES-GCM, bound to endpoint id, returned only once.
- Admin: scrypt password, short-lived JWT with pinned algorithm, static token compared in constant time.
- Login rate-limited per IP; per-endpoint rate limit after authentication.
- SSRF: scheme allowlist, IP checks, DNS pinning, no redirects, blocked = dead.
- WebSocket: origin allowlist, auth deadline, connection cap, frame cap, backpressure cutoff, heartbeat.
- No secrets in logs, git, error responses, or benchmark output.
- Documented trade-offs: rate limiter fails open; secrets decrypted per request (until caching is added).

---

## Part E — Suggested learning order summary

1. Java + Spring Boot basics → 2. SQL + transactions → 3. Crypto basics (hash, HMAC, AES-GCM) → 4. REST API → 5. Redis → 6. RabbitMQ (exchanges, queues, acks, confirms, TTL, DLQ) → 7. Concurrency (virtual threads, ordering) → 8. WebSockets → 9. Docker + nginx → 10. Testing + chaos → 11. Performance.

Build the phases in order. After each phase, the system should run and do something visible. If a phase does not work end to end, fix it before starting the next.
