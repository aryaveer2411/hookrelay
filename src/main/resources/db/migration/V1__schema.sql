-- A registered webhook destination.
CREATE TABLE endpoints
(
    id              uuid PRIMARY KEY     DEFAULT gen_random_uuid(), -- endpoint identifier
    name            text        NOT NULL,                           -- human-readable label
    target_url      text        NOT NULL,                           -- URL events are delivered to
    inbound_secret  bytea       NOT NULL,                           -- verifies signatures on incoming webhooks
    outbound_secret bytea       NOT NULL,                           -- signs outbound delivery requests
    rate_per_sec    int         NOT NULL DEFAULT 50,                -- delivery rate limit for this endpoint
    ordered         boolean     NOT NULL DEFAULT false,             -- whether events must be delivered in order
    disabled_at     timestamptz,                                    -- set when the endpoint is paused/disabled
    created_at      timestamptz NOT NULL DEFAULT now()              -- registration time
);