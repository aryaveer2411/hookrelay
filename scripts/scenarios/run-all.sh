#!/usr/bin/env bash
cd "$(dirname "$0")"
status=0
for s in worker-kill broker-restart redis-flush; do
  echo ""
  echo "================ $s ================"
  if ./$s.sh; then echo "================ $s: PASS"; else echo "================ $s: FAIL"; status=1; fi
  sleep 3
done
exit $status
