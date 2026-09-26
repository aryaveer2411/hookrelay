#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
preflight
trap stop_worker EXIT

start_worker worker-1
run_load
sleep $((DURATION / 2))

echo ">>> kill -9 the worker (no chance to clean up)"
kill_worker
sleep 2
start_worker worker-2

finish
