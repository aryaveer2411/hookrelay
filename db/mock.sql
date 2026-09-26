CREATE SCHEMA IF NOT EXISTS mock;
CREATE TABLE IF NOT EXISTS mock.received (
  id              bigserial PRIMARY KEY,
  webhook_id      text NOT NULL,
  status_returned int  NOT NULL,
  body            jsonb,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS received_webhook ON mock.received (webhook_id);
