#!/usr/bin/env bash
# Shared helpers for the failure scenarios. Sourced by each scenario script.
set -euo pipefail
SCENARIO=$(basename "$0" .sh)
cd "$(dirname "$0")/../.."        # always run from the project root
set -a; source .env; set +a

RUN_DIR="logs/${SCENARIO}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR"
export RATE=${RATE:-100}
export DURATION=${DURATION:-60}

check_up() {
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$2")" = "000" ]; then
    echo "✖ $1 is not running ($2)"; exit 1
  fi
}

preflight() {
  check_up ingest http://127.0.0.1:3000/api/endpoints
  check_up mock-target http://127.0.0.1:4000/hook
  pgrep -f 'src/relay.ts' > /dev/null || { echo '✖ relay is not running'; exit 1; }
  if pgrep -f 'src/worker.ts' > /dev/null; then
    echo '✖ stop your worker terminal first (Ctrl+C). This script starts its own worker.'; exit 1
  fi
  # make sure the mock answers 200
  curl -s -X POST http://127.0.0.1:4000/_mode -H 'content-type: application/json' \
    -d '{"status":200,"durationSec":1}' > /dev/null
  echo "✔ everything is running. Logs: $RUN_DIR"
}

start_worker() {
  local name=$1 primary=${2:-} log="$RUN_DIR/$1.log" started=$SECONDS
  (cd apps/worker && ENV_WORKER_NAME="$name" ENV_WORKER_PRIMARY="$primary" \
    nohup node --env-file=../../.env --import tsx src/worker.ts > "../../$log" 2>&1 & \
    echo $! > "../../$RUN_DIR/$name.pid")
  for _ in $(seq 40); do
    if grep -q 'worker reading' "$log" 2>/dev/null; then
      echo "✔ $name up in $((SECONDS - started))s${primary:+ (primary: $primary)}"; return 0
    fi
    sleep 0.5
  done
  echo "✖ $name did not start within 20s, see $log"; exit 1
}

kill_worker() { pkill -9 -f 'src/worker.ts' || true; }
stop_worker() { pkill -TERM -f 'src/worker.ts' 2>/dev/null || true; }

run_load() {
  OUT="$RUN_DIR/accepted.txt" node scripts/load.mjs &
  LOAD_PID=$!
}

finish() {
  wait "$LOAD_PID"
  node scripts/reconcile.mjs "$RUN_DIR/accepted.txt"
}

kill_one() { kill -9 "$(cat "$RUN_DIR/$1.pid")" 2>/dev/null || true; }

run_ordered_load() {
  OUT="$RUN_DIR/accepted.txt" node scripts/load-ordered.mjs &
  LOAD_PID=$!
}

finish_ordered() {
  wait "$LOAD_PID"
  local status=0
  node scripts/reconcile.mjs "$RUN_DIR/accepted.txt" || status=1
  node scripts/check-order.mjs "$RUN_DIR/accepted.txt" || status=1
  return $status
}
