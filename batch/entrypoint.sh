#!/bin/sh
set -e

echo "waiting for core-db and cobol-lb to be reachable..."
sleep 15

echo "running interest batch once at startup for demo visibility..."
python /app/interest_batch.py || true

echo "starting cron for recurring batch window..."
crontab /app/crontab
crond -f -L /dev/stdout
