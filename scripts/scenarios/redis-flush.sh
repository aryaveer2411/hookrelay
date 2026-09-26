#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
export DUP_EVERY=10   # every 10th request re-sends an old webhook-id
preflight
trap stop_worker EXIT

start_worker worker
run_load
sleep $((DURATION / 2))

echo ">>> FLUSHALL: wipe everything in Redis"
docker compose exec -T redis redis-cli FLUSHALL

finish
