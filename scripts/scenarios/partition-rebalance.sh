#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
preflight
trap stop_worker EXIT

start_worker worker-a p0,p1,p2,p3
start_worker worker-b p4,p5,p6,p7
sleep 6

run_ordered_load
sleep $((DURATION / 2))

echo ">>> target fails for 15s, so some endpoints have retries waiting on their old partition"
curl -s -X POST http://127.0.0.1:4000/_mode -H 'content-type: application/json' \
  -d '{"status":503,"durationSec":15}' > /dev/null
sleep 2

echo ">>> add a partition while traffic is flowing"
npm run --silent partition:add -w apps/relay

finish_ordered
