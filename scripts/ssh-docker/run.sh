#!/bin/sh
set -eu
umask 077

cleanup_fixture() {
    if [ -n "$container" ]; then
        docker rm -f "$container" >/dev/null || :
    fi
    if [ -n "$fixture" ]; then
        rm -rf "$fixture"
    fi
}

start_fixture() {
    fixture=
    container=
    trap cleanup_fixture EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    fixture=$(mktemp -d)

    mkdir "$fixture/server"
    # Reuse rust-linux-test's intermediate build cache. Keep the final binary in this
    # fixture so a concurrent build in another checkout cannot overwrite it.
    docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e HOME=/tmp \
        -e CARGO_PROFILE_DEV_DEBUG -e CARGO_PROFILE_TEST_DEBUG -e CARGO_INCREMENTAL \
        -v "$PWD":/w -w /w -v "$fixture":/fixture \
        -v statglass-linux-cargo:/usr/local/cargo \
        -v statglass-linux-rustup:/usr/local/rustup \
        -e CARGO_TARGET_DIR=/usr/local/cargo/target-linux \
        rust:1.99-bookworm scripts/linux-test-entry.sh sh -ec \
        'export CARGO_BUILD_BUILD_DIR="$CARGO_TARGET_DIR"
         cargo build --locked -p statglass-agent --target-dir /fixture/artifacts
         mv /fixture/artifacts/debug/statglass-agent /fixture/server/
         if [ "$1" = --seed ]; then
             cargo build --locked -p statglass-store --example seed --target-dir /fixture/artifacts
             mv /fixture/artifacts/debug/examples/seed /fixture/server/
         fi' sh "${1-}"

    ssh-keygen -q -t ed25519 -N '' -f "$fixture/server/host"
    # The software signer decodes named P-256 parameters. ssh-keygen -m PEM can
    # emit explicit parameters, depending on the host's OpenSSL version.
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
        -pkeyopt ec_param_enc:named_curve -out "$fixture/client"
    openssl pkcs8 -topk8 -nocrypt -in "$fixture/client" -outform DER -out "$fixture/client.der"
    ssh-keygen -y -f "$fixture/client" > "$fixture/server/authorized_keys"
    # A paired phone's device key (D-151): its line forces the agent's restricted session.
    # The tag is fixed, not derived from the key, so the tests can name it.
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
        -pkeyopt ec_param_enc:named_curve -out "$fixture/restricted"
    openssl pkcs8 -topk8 -nocrypt -in "$fixture/restricted" -outform DER -out "$fixture/restricted.der"
    agent_bin=/usr/local/bin/statglass-agent
    socket=/home/statglass/run/agent.sock
    data_dir=/home/statglass/.local/state/statglass-agent
    printf 'restrict,command="%s restricted --device 0BADC0 --socket %s" %s statglass-mobile:0BADC0 docker-fixture\n' \
        "$agent_bin" "$socket" "$(ssh-keygen -y -f "$fixture/restricted" | cut -d ' ' -f 1-2)" \
        >> "$fixture/server/authorized_keys"

    docker build --tag statglass-ssh-docker scripts/ssh-docker
    container=statglass-ssh-docker-${fixture##*/}
    docker run --detach --name "$container" --publish 127.0.0.1::22 -v "$fixture/server":/fixture:ro \
        statglass-ssh-docker sh -ec '
            install -m 600 /fixture/host /etc/ssh/fixture_host_key
            install -m 644 /fixture/host.pub /etc/ssh/ssh_host_ed25519_key.pub
            install -d -o statglass -g statglass -m 700 /home/statglass/.ssh
            # A writable copy, not the read-only mount: pairing tests edit it.
            install -o statglass -g statglass -m 600 /fixture/authorized_keys /home/statglass/.ssh/authorized_keys
            install -m 755 /fixture/statglass-agent /usr/local/bin/statglass-agent
            if [ -f /fixture/seed ]; then
                install -m 755 /fixture/seed /usr/local/bin/statglass-seed
            fi
            install -d -o statglass -g statglass -m 700 /home/statglass/.local \
                /home/statglass/.local/bin /home/statglass/.local/state "$1"
            ln -s /usr/local/bin/statglass-agent /home/statglass/.local/bin/statglass-agent
            ln -s "$2" "$1/metrics.sock"
            exec /usr/sbin/sshd -D -e -f /dev/null -h /etc/ssh/fixture_host_key \
                -o UsePAM=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
                -o PermitRootLogin=no -o AllowUsers=statglass
        ' sh "$data_dir" "$socket" >/dev/null

    host=127.0.0.1
    address=$(docker port "$container" 22/tcp)
    port=${address##*:}
    printf '[%s]:%s %s\n' "$host" "$port" "$(cat "$fixture/server/host.pub")" > "$fixture/known_hosts"
    cat > "$fixture/ssh_config" <<EOF
Host statglass-docker
    HostName $host
    Port $port
    User statglass
    IdentityFile "$fixture/client"
    IdentityAgent none
    IdentitiesOnly yes
    UserKnownHostsFile "$fixture/known_hosts"
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    BatchMode yes
EOF

    # A successful SSH exec also waits for the container's startup to install the agent.
    attempt=0
    until ssh -F "$fixture/ssh_config" -o ConnectTimeout=1 statglass-docker test -x "$agent_bin" > "$fixture/ready.log" 2>&1; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 30 ]; then
            cat "$fixture/ready.log" >&2
            docker logs "$container" >&2
            exit 1
        fi
        sleep 0.2
    done
    start_agent
}

start_agent() {
    docker exec --detach --user statglass "$container" sh -ec '
        umask 077
        exec >> "$1" 2>&1
        shift
        mkdir -p "$(dirname "$1")"
        printf "%s\n" "$$" > "$1"
        shift
        exec "$@"
    ' sh "$data_dir/fixture-agent.log" "${socket%/*}/agent.pid" "$agent_bin" run --socket "$socket"
    attempt=0
    until host_id=$(ssh -F "$fixture/ssh_config" -o ConnectTimeout=1 statglass-docker \
        "$agent_bin" status --json --socket "$socket" | python3 -c '
import json, sys
status = json.load(sys.stdin)
if not status["running"]:
    sys.exit(1)
print(status["host_id"])
    '); do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 30 ]; then
            echo 'ssh-docker-test: agent never answered on its socket' >&2
            docker exec --user statglass "$container" cat "$data_dir/fixture-agent.log" >&2 || :
            docker logs "$container" >&2
            exit 1
        fi
        sleep 0.2
    done
}

run_tests() {
    key_type=$(cut -d ' ' -f 1 "$fixture/server/host.pub")
    fingerprint=$(ssh-keygen -lf "$fixture/server/host.pub" -E sha256 | cut -d ' ' -f 2)
    export STATGLASS_SSH_DOCKER_HOST="$host" STATGLASS_SSH_DOCKER_PORT="$port" STATGLASS_SSH_DOCKER_USER=statglass
    export STATGLASS_SSH_DOCKER_KEY="$fixture/client.der" STATGLASS_SSH_DOCKER_HOST_KEY="$key_type $fingerprint"
    export STATGLASS_SSH_DOCKER_SSH_CONFIG="$fixture/ssh_config"
    export STATGLASS_SSH_DOCKER_AGENT_BIN="$agent_bin" STATGLASS_SSH_DOCKER_SOCKET="$socket" STATGLASS_SSH_DOCKER_HOST_ID="$host_id"
    export STATGLASS_SSH_DOCKER_CONTAINER="$container" STATGLASS_SSH_DOCKER_RESTRICTED_KEY="$fixture/restricted.der"

    status=0
    cargo test -p statglass-ssh --features software-signer --test docker -- --ignored || status=$?
    cargo test -p statglass-remote --test docker_openssh -- --ignored || status=$?
    # The restricted-session and pairing suites (phase 5 lanes a and b); each runs once its
    # test file exists.
    if [ -f crates/statglass-remote/tests/docker_restricted.rs ]; then
        cargo test -p statglass-remote --test docker_restricted -- --ignored || status=$?
    fi
    if [ -f crates/statglass-ssh/tests/docker_pair.rs ]; then
        cargo test -p statglass-ssh --features software-signer --test docker_pair -- --ignored || status=$?
    fi
    cargo test -p statglass-mobile --lib sessions::tests::docker::mobile_session -- --ignored --exact || status=$?
    cargo test -p statglass-mobile --test network_addresses addresses_from_the_restricted_linux_agent -- --ignored --exact || status=$?
    cargo test -p statglass-mobile --test mobile_session mobile_core_streams_and_reads_host_history -- --ignored --exact || status=$?
    cargo test -p statglass-mobile --test docker_pair -- --ignored || status=$?
    cargo test -p statglass-mobile --test docker_demand -- --ignored --nocapture || status=$?
    exit "$status"
}

if [ "${0##*/}" = run.sh ]; then
    cd "$(dirname "$0")/../.."
    start_fixture
    run_tests
fi
