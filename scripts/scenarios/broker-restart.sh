#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
preflight
trap stop_worker EXIT

start_worker worker
run_load
sleep $((DURATION / 2))

echo ">>> restart RabbitMQ"
docker compose restart rabbitmq

finish
