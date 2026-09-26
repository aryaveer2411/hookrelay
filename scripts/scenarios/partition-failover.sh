#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
preflight
trap stop_worker EXIT

start_worker worker-a p0,p1,p2,p3
start_worker worker-b p4,p5,p6,p7
sleep 6   # let both join the other half as standby

run_ordered_load
sleep $((DURATION / 2))

echo ">>> kill -9 worker-a (active on p0-p3). worker-b should take over."
kill_one worker-a

finish_ordered
