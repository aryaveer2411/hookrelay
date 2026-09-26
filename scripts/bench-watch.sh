#!/usr/bin/env bash
# Every 5s: what's waiting where, and which containers are busiest.
cd "$(dirname "$0")/.."
set -a; source .env; set +a
mkdir -p logs
while true; do
  unsent=$(docker compose exec -T postgres psql -U "$ENV_DB_USER" -d "$ENV_DB_NAME" -tAc \
    "SELECT count(*) FROM outbox WHERE sent_at IS NULL")
  queued=$(docker compose exec -T rabbitmq rabbitmqctl -q list_queues name messages --no-table-headers \
    | awk '$1 ~ /^deliver\./ {s+=$2} END {print s+0}')
  echo "$(date +%T)  outbox_unsent=$unsent  deliver_queues=$queued"
  docker stats --no-stream --format '  {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | sort -t$'\t' -k2 -rn | head -5
  sleep 5
done | tee -a logs/bench-watch.txt
