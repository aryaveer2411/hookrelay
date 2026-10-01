-- A received webhook payload, deduped per endpoint and tracked to delivery.
CREATE TABLE events
(
    id          uuid PRIMARY KEY     DEFAULT gen_random_uuid(),                          -- event identifier
    endpoint_id uuid        NOT NULL REFERENCES endpoints (id),                          -- destination endpoint
    external_id text        NOT NULL,                                                    -- source-provided id, used for dedup
    payload     jsonb       NOT NULL,                                                    -- raw webhook body
    status      text        NOT NULL CHECK (status IN ('pending', 'delivered', 'dead')), -- delivery lifecycle state
    received_at timestamptz NOT NULL DEFAULT now(),                                      -- ingestion time
    UNIQUE (endpoint_id, external_id)                                                    -- dedup guard
);

-- Transactional outbox queue that hands off events to the delivery worker.
CREATE TABLE outbox
(
    id        bigserial PRIMARY KEY,                -- queue entry id
    event_id  uuid NOT NULL REFERENCES events (id), -- event to deliver
    sent_at   timestamptz,                          -- set once handed off/dispatched
    partition text                                  -- shard/ordering key for the worker
);

-- Audit log of each outbound delivery attempt for an event.
CREATE TABLE delivery_attempts
(
    id          bigserial PRIMARY KEY,                       -- attempt id
    event_id    uuid        NOT NULL REFERENCES events (id), -- event being delivered
    attempt     int         NOT NULL,                        -- attempt number
    status_code int,                                         -- HTTP status returned by the target
    error       text,                                        -- error message on failure
    latency_ms  int,                                         -- request latency
    created_at  timestamptz NOT NULL DEFAULT now()           -- attempt time
);

-- Audit log of manual event replays.
CREATE TABLE replays
(
    id          bigserial PRIMARY KEY,                       -- replay id
    event_id    uuid        NOT NULL REFERENCES events (id), -- event that was replayed
    replayed_by text        NOT NULL,                        -- who triggered the replay
    created_at  timestamptz NOT NULL DEFAULT now()           -- replay time
);

CREATE INDEX outbox_unsent ON outbox (id) WHERE sent_at IS NULL; -- fast lookup of undispatched outbox rows
CREATE INDEX attempts_by_event ON delivery_attempts (event_id, attempt); -- fetch an event's attempts in order
CREATE INDEX events_page ON events (endpoint_id, received_at DESC, id DESC); -- cursor pagination of an endpoint's events
CREATE INDEX events_pending ON events (endpoint_id) WHERE status = 'pending'; -- fast lookup of an endpoint's pending events
CREATE INDEX IF NOT EXISTS outbox_event ON outbox (event_id);