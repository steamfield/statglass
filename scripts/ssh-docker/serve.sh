#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
. ./scripts/ssh-docker/run.sh

usage() {
    printf '%s\n' 'usage: serve.sh [--seed] | serve.sh --stop CONTAINER' >&2
    exit 2
}

wait_for_history() {
    attempt=0
    # The agent batches SQLite commits. Wait for a sampled minute, then let
    # graceful shutdown flush the writer before the seeder opens the store.
    until docker exec --user statglass "$container" grep -q 'engine minute' "$data_dir/fixture-agent.log"; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 75 ]; then
            echo 'serve.sh: agent did not finish a sampled minute before seeding' >&2
            docker exec --user statglass "$container" cat "$data_dir/fixture-agent.log" >&2 || :
            exit 1
        fi
        sleep 1
    done
}

case "${1-}" in
    --stop)
        [ "$#" -eq 2 ] || usage
        case "$2" in
            statglass-ssh-docker-?*) exec docker rm -f "$2" ;;
            *) usage ;;
        esac
        ;;
    --seed) [ "$#" -eq 1 ] || usage ;;
    '') [ "$#" -eq 0 ] || usage ;;
    *) usage ;;
esac

start_fixture "${1-}"
if [ "${1-}" = --seed ]; then
    wait_for_history
    docker exec --user statglass "$container" sh -ec '
        pid=$(cat "$1")
        kill -TERM "$pid"
        attempt=0
        while kill -0 "$pid" 2>/dev/null; do
            attempt=$((attempt + 1))
            if [ "$attempt" -ge 60 ]; then
                echo "serve.sh: agent did not stop before seeding" >&2
                exit 1
            fi
            sleep 0.2
        done
    ' sh "${socket%/*}/agent.pid"
    docker exec --user statglass "$container" /usr/local/bin/statglass-seed --dir "$data_dir" --days 30
    # The seeder reports writes before pruning. Count the retained tiers after it closes the store.
    docker cp "$container:$data_dir/history.sqlite" "$fixture/seeded.sqlite"
    python3 - "$fixture/seeded.sqlite" <<'PY'
from pathlib import Path
import sqlite3
import sys

with sqlite3.connect(Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True) as store:
    for tier, table in (("S10", "tier_10s"), ("M1", "tier_1m"), ("M15", "tier_15m")):
        count, = store.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
        if count == 0:
            sys.exit(f"No seeded rows in {tier}")
        print(f"{tier} rows: {count}")
PY
    start_agent
fi

printf 'host=%s\nport=%s\ncontainer=%s\nagent=%s\n' "$host" "$port" "$container" "$agent_bin"
printf 'Pair with: docker exec -it --user statglass %s %s pair --target lan=%s --port %s\n' \
    "$container" "$agent_bin" "$host" "$port" >&2
container=
