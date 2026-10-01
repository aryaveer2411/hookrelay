-- Secrets are no longer stored on the endpoint row.
ALTER TABLE endpoints
DROP
COLUMN inbound_secret,
    DROP
COLUMN outbound_secret;
