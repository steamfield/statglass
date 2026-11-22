# Plan: connection and engine error states

Skill: sprint. Profile: sprint. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/marketplaces/claude-essentials/plugins/ce/shared/scripts/plan_graph.py
Started: 1795352757. Timebox: none. Landing branch: sprint/connection-states.
Gate: `make rust-check && cargo test -p statglass-schema -p statglass-collect -p statglass-engine -p statglass-remote && cargo test -p statglass && bun run check`. Filtered tests: `cargo test -p <crate> <name filter>` and `bun run test -- <path>`. Typecheck: `bun run typecheck` and `cargo check --workspace --all-targets`.
Runner: plain commands. Rust commands in lane worktrees are prefixed with `CARGO_TARGET_DIR=/Users/riley/.t3/worktrees/statglass/connection-states/target` so lanes share one build cache.
Worktree setup: `bun install --frozen-lockfile && make stub-dist`.
Suppressions: biome-ignore, #[allow(, #[expect(
Manifests: Cargo.toml, package.json

## Spec

Hosts and Containers tell the user what actually went wrong when a remote host or the local Docker engine can't be reached, what StatGlass is doing about it (backing off and retrying, waiting for the network) and what the user can do (retry now, turn on Tailscale, open Docker Desktop). Rust classifies every failure; the UI only maps classifications to copy.

Already on main (0.12.1, d0753034), not rebuilt here: `ConnectionFailureKind` (unreachable, timeout, authentication, host_key, agent_not_running, incompatible, identity_changed, protocol), `remoteConnectionView` copy, "Reconnecting…" card state, Retry button, 1 s to 60 s exponential backoff with jitter in `statglass-remote/src/source.rs::run`, network-change and wake cutting the backoff short, Docker 1 s to 30 s backoff.

In scope:
- Remote failures gain the kinds `name_not_resolved`, `refused`, `no_route` (from SSH stderr), and `local_offline`, `tailscale_down` (from this Mac's interfaces at failure time). Dual-route hosts keep a per-route failure list.
- Tailscale detection is local only: an up interface with an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48. No `tailscale` CLI.
- When this Mac is offline, remote sources stop dialing and wait for a network change (60 s fallback); Hosts shows one page-level notice and cards read "Waiting for network".
- Failing host cards show the countdown to the next automatic attempt ("Retrying in 14 s"), "Trying…" during a dial, and "Retry now" which cuts the wait.
- Containers with an unreachable engine shows one focal state card instead of the empty chart and table, with distinct copy for not installed, not running, stopped mid-session, choose an engine, selected engine missing, permission denied and incompatible API. Saved history stays one click away.
- "Open Docker Desktop" / "Open OrbStack" / "Open Rancher Desktop" launches an installed, allowlisted runtime by bundle id; the engine then retries every 2 s for 60 s. Colima shows `colima start` with Copy.

Out of scope: `tailscale status` peer state, auto-starting runtimes without a click, Docker on remote hosts, changing `DockerStatus` or coverage reasons, changing backoff bounds.

Assumptions (override any): remote backoff stays 1 s doubling to 60 s with up to 250 ms jitter, and a manual retry does not reset the doubling. Docker backoff stays 1 s to 30 s outside a launch window. Another VPN using 100.64.0.0/10 would read as Tailscale; accepted. Priority when two routes fail differently: local_offline > tailscale_down > agent_not_running > refused > timeout > no_route > name_not_resolved > unreachable (most actionable on this Mac first).

Error model: SSH dial failures become `RemoteError::Unreachable { kind, detail }` or `RemoteError::Timeout` in `transport.rs`; a dual-route failure becomes `RemoteError::BothRoutes { lan, tailscale }` keeping both causes. `ConnectionStatus::record_failure` maps the error into `failure_kind` and `route_failures`; `ConnectionStatus::apply_network` refines them against a `LocalNetwork` probe. The raw stderr stays in `error` for Technical details. Docker connect failures map to `DockerAvailability.reason` through a pure classifier; `PermissionDenied`/`Incompatible` keep their `DockerStatus`. Launch failures return `CommandError` and show inline under the button. Nothing is swallowed: every failure reaches a status field or a command error.

## Contracts (scaffold commit)

    crates/statglass-remote/src/
      lib.rs               RemoteError gains Unreachable { kind: UnreachableKind, detail } and BothRoutes { lan, tailscale }
      network.rs           NEW: LocalNetwork probe (getifaddrs) and refine(kind, route, net); pure refine
      source/status.rs     ConnectionFailureKind + 5 variants; RouteFailure; route_failures; record_failure; apply_network
      transport.rs         SSH stderr -> Unreachable kinds; combine() -> BothRoutes
    src-tauri/src/remote/
      contracts.rs         RemoteFailureKind + 5 variants; RemoteRouteFailure; RemoteHostStatus.route_failures
      registration.rs      connection_status maps route_failures; rendered_status_changed compares it
    src/core/
      remote-connection.ts RemoteConnectionKind + 5 kinds; per-kind copy; routeLines
      mock/remote-updates.ts, mock/fixtures.ts   scenarios for each new kind

## Phases

### Phase 1: hosts say why they can't connect (MVP)

Scaffold: eaeb2a40
Demo: `bun run dev:fast`, open `/?route=/dashboard/hosts&scenario=hosts-dashboard,host-name-not-resolved,host-refused,host-tailscale-down,host-tailscale-silent,mac-offline`; each failing card names its cause. In the real app, turn Tailscale off and watch a Tailscale-only host read "Tailscale is off on this Mac".
Test cases:
- stderr "ssh: Could not resolve hostname studio.local: nodename nor servname provided, or not known" -> Unreachable/NameNotResolved.
- stderr "ssh: connect to host 10.0.0.5 port 22: Connection refused" -> Refused.
- stderr "No route to host", "Network is unreachable", "Host is down" -> NoRoute.
- stderr "Operation timed out" stays Timeout; host key and auth stderr keep their kinds.
- Dual route LAN NameNotResolved + Tailscale Timeout -> BothRoutes; failure_kind timeout; route_failures [lan:name_not_resolved, tailscale:timeout].
- Dual route where one side is non-retryable still returns that side's error alone (existing behavior).
- refine: offline + any network kind except refused -> local_offline; Tailscale route + tailscale down + name/no_route/timeout/unreachable -> tailscale_down; LAN route unaffected by Tailscale; non-network kinds unchanged.
- apply_network recomputes failure_kind from refined route_failures by priority.
- Interface classification: 100.64.0.1 and 100.127.255.254 are Tailscale, 100.63.255.255 and 100.128.0.0 are not; fd7a:115c:a1e0::1 is Tailscale; 169.254.x and fe80:: and loopback do not count as online.
- Shell maps every new kind and route_failures; a route_failures change re-emits status.
- TS: each new failure kind maps to its view kind, tone warning, retry action, and the copy in the lane 1/b brief; routeLines lists one line per failed route; mock scenarios render.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-remote/src/network.rs, crates/statglass-remote/src/source/status.rs, crates/statglass-remote/src/transport.rs, crates/statglass-remote/src/lib.rs, crates/statglass-remote/src/source.rs, src-tauri/src/remote/registration.rs | contracts | crates/statglass-remote/src/network/tests.rs, crates/statglass-remote/src/source/status/network_tests.rs, crates/statglass-remote/src/transport/classify_tests.rs, src-tauri/src/remote/registration/tests.rs | opus | running | sprint/connection-states-1a | cargo tests for statglass-remote and statglass registration pass, clippy clean |
| b | M | src/core/remote-connection.ts, src/core/remote-connection-network.ts, src/core/mock/remote-updates.ts, src/core/mock/remote-network-scenarios.ts, src/core/mock/remote.ts, src/core/mock/stream.ts, src/app/routes/dashboard/hosts/_lib/host-card-model.ts | contracts, src/core/remote-connection.test.ts | src/core/remote-connection.test.ts, src/core/remote-connection-kinds.test.ts, src/app/routes/dashboard/hosts/_lib/host-card-model.test.ts | sonnet | running | sprint/connection-states-1b | bun tests pass, typecheck clean |

#### Lane a brief

- Goal: Rust classifies remote dial failures precisely (DNS, refused, no route, timeout) per route, and refines them with this Mac's network state (offline, Tailscale down) before publishing status.
- Interface: scaffold commits the types. Implement `network::probe() -> LocalNetwork` (libc getifaddrs; an interface counts when IFF_UP and IFF_RUNNING and not IFF_LOOPBACK), `network::classify_address(IpAddr) -> AddressClass { Tailscale, Routable, Ignored }`, `network::refine(ConnectionFailureKind, Route, LocalNetwork) -> ConnectionFailureKind`, `ConnectionStatus::record_failure(&mut self, e: &RemoteError, single_route: Option<Route>)`, `ConnectionStatus::apply_network(&mut self, net: LocalNetwork)`, `ConnectionFailureKind::priority(self) -> u8` (lower is more actionable), `transport::stderr_error` producing `RemoteError::Unreachable`, `transport::combine` producing `RemoteError::BothRoutes`. In `source.rs::run`, after `record_failure` call `apply_network(network::probe())` (probe runs inside `tokio::task::spawn_blocking` or directly; it is a single syscall). `single_route` comes from `EndpointConfig`: Some(Lan) when only lan is set, Some(Tailscale) when only tailscale is set, None for both.
- Behavior:
  - `RemoteError::Unreachable` and `BothRoutes` are retryable. `BothRoutes` Display is `LAN: {lan}; Tailscale: {tailscale}` (unchanged text from today's combine).
  - combine keeps today's precedence for non-retryable sides and AgentNotRunning (returns AgentNotRunning(combined text) as today); otherwise returns BothRoutes.
  - from_error: Unreachable{kind} -> NameNotResolved/Refused/NoRoute; BothRoutes -> the lower `priority()` of the two sides' kinds.
  - record_failure fills route_failures: BothRoutes -> [lan, tailscale] in that order; any other error with single_route Some(r) -> [r: kind]; None -> [] (a dual-route host whose error was not combined, e.g. non-retryable, gets []).
  - apply_network: refine each route failure; if route_failures is non-empty set failure_kind to the min-priority refined kind; else refine failure_kind against... nothing (leave it). Exception: when `!net.online`, failure_kind becomes LocalOffline whenever it is a network kind even with empty route_failures.
  - Network kinds: NameNotResolved, Refused, NoRoute, Timeout, Unreachable. refine never changes Authentication, HostKey, AgentNotRunning, Incompatible, IdentityChanged, Protocol. Offline does not turn Refused into LocalOffline (a host answered).
  - On success, route_failures clears with failure_kind.
  - Shell: `connection_status` maps route_failures to `RemoteRouteFailure`; `map_failure_kind` covers the 5 new kinds; `rendered_status_changed` compares route_failures.
  - Keep `source.rs` within its 1000-line ceiling: the run-loop change is one or two lines.
  - The existing inline test in `transport.rs` asserting `combine(Transport, Timeout)` returns `Timeout(..)` changes: that pair now returns `BothRoutes`. Update that assertion only; the AgentNotRunning assertion stays.
  - `network::probe` logs a `tracing::warn!` with the OS error when getifaddrs fails, then returns online with Tailscale up.
- Decisions already made: local interface check only; no CLI. Priority order in the plan's Assumptions.
- Out of scope: offline waiting, backoff fields, attempt counters (phase 2). Any UI.
- Done when: `CARGO_TARGET_DIR=... cargo test -p statglass-remote` and `cargo test -p statglass registration` pass, `cargo clippy -p statglass-remote -p statglass --all-targets -- -D warnings` clean, `python3 scripts/architecture/rust_size.py` (via `make architecture-check`) passes.

#### Lane b brief

- Goal: the UI maps the five new failure kinds to specific copy and the mock can show each one.
- Interface: `RemoteConnectionKind` gains `"name_not_resolved" | "refused" | "no_route" | "local_offline" | "tailscale_down"` (scaffold). `RemoteConnectionView` gains `routeLines: readonly string[]` (scaffold). Implement `classifyFailure` mapping each `RemoteFailureKind` to the same-named view kind, and `copyForKind` cases. `routeLines` has one entry per `status.route_failures` item: `"<Label> (<alias>): <reason>"` with reasons: name_not_resolved "name not found on this network", refused "SSH refused the connection", no_route "no route from this Mac", timeout "didn't answer in time", tailscale_down "Tailscale is off on this Mac", local_offline "this Mac is offline", unreachable "couldn't connect", agent_not_running "StatGlass isn't running there"; other kinds "connection failed". `buildDiagnostics` appends `Route <Label>: <kind>` per route failure.
- Copy (tone "warning", primaryAction "retry", showRetry `config.enabled`, meta `${fact}${retryTag}` as the existing timeout case, sidebarLabel `autoRetrying ? "Reconnecting…" : <label>`, pillLabel "Offline"):
  - local_offline: title "This Mac is offline"; summary "StatGlass will reconnect to {name} when this Mac is back online. Saved history stays available."; shortReason "This Mac is offline."; gif "network-error"; label "Waiting for network".
  - tailscale_down: title "Tailscale is off on this Mac"; summary when a LAN route is also configured "{name} isn't reachable on this network, and Tailscale is off on this Mac. Turn on Tailscale to reconnect." else "{name} connects over Tailscale ({alias}). Turn on Tailscale on this Mac to reconnect."; shortReason "Tailscale is off on this Mac."; gif "network-error"; label "Tailscale off".
  - timeout, when route_failures has a tailscale entry with kind timeout and no LAN entry of kind refused: title "{name} isn't responding"; summary "Tailscale is on, but {name} didn't answer at {alias}. It may be asleep, shut down or signed out of Tailscale."; shortReason "Not responding on Tailscale."; otherwise keep today's timeout copy.
  - name_not_resolved: title "Can't find {name}"; summary for a LAN-only failure "{alias} didn't resolve on this network. If you're away from {name}'s network, add a Tailscale address in host settings." and for a Tailscale route "Tailscale couldn't find {alias}. Check the name in host settings."; shortReason "{alias} wasn't found."; gif "not-found"; label "Not found".
  - refused: title "{name} refused SSH"; summary macOS "{name} answered but isn't accepting SSH. Turn on Remote Login in System Settings › General › Sharing on {name}." Linux "{name} answered but isn't accepting SSH. Start sshd on {name}."; shortReason "SSH connection refused."; gif "server-error"; label "SSH refused".
  - no_route: title "Can't reach {name}"; summary "This Mac has no route to {routeText}. {networkHint}"; shortReason "No route to {name}."; gif "network-error"; label "No route".
  - `{alias}` is the alias of the route that carries the failure (from route_failures), falling back to the first configured route. Use typographic apostrophes as the existing copy does.
- host-card-model: `connectingState` and the `error` case use `remoteConnectionView(remote).shortReason` for the message (already true for connecting); `status` text for a failing connecting card stays "Reconnecting…" except local_offline, which reads "Waiting for network" with mark "idle".
- Mock: add scenarios `host-name-not-resolved`, `host-refused`, `host-tailscale-down`, `host-tailscale-silent`, `mac-offline` (names already in SCENARIOS from the scaffold). Seed them in `seedMonitoringScenarios`-style code in `remote-updates.ts` like `host-unreachable`, each a host with realistic `error` stderr text and `route_failures`; `mac-offline` puts every remote host in local_offline. `retryRemoteHost` in `remote.ts` keeps these hosts failing as it does for host-unreachable.
- Out of scope: countdown, dialing state, page notice (phase 2). No changes to error-state-card.tsx or host card components.
- Done when: `bun run test -- src/core/remote-connection src/app/routes/dashboard/hosts` passes and `bun run typecheck` is clean.

### Phase 2: backoff you can see, and waiting for the network

Demo: scenarios `host-backoff`, `mac-offline` on Hosts: countdown ticks, Retry now flips to "Trying…", one offline notice.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-remote/src/source.rs, crates/statglass-remote/src/source/backoff.rs, crates/statglass-remote/src/source/status.rs, src-tauri/src/remote/registration.rs | contracts | crates/statglass-remote/src/source/backoff_tests.rs | opus | pending | | |
| b | M | src/app/routes/dashboard/hosts/_components/host-card-status.tsx, src/app/routes/dashboard/hosts/_components/host-card-actions.tsx, src/app/routes/dashboard/hosts/_components/hosts-offline-notice.tsx, src/app/routes/dashboard/hosts/_hooks/use-retry-countdown.ts, src/app/routes/dashboard/hosts/_lib/host-card-model.ts, src/app/routes/dashboard/hosts/route.tsx, src/core/mock/remote-updates.ts | contracts | | opus | pending | | |

(Briefs written during phase 1.)

### Phase 3: Docker engine states and launching the runtime

Demo: `/?route=/dashboard/containers&scenario=docker-not-running` shows the focal card; Open Docker Desktop flips it to live in the mock.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | crates/statglass-collect/src/docker_runtimes.rs, crates/statglass-engine/src/docker/availability.rs, crates/statglass-engine/src/docker/worker.rs, crates/statglass-engine/src/docker/mod.rs, src-tauri/src/docker.rs | contracts | | opus | pending | | |
| b | M | src/app/routes/dashboard/containers/_components/docker-engine-state.tsx, src/app/routes/dashboard/containers/_lib/engine-state.ts, src/app/routes/dashboard/containers/route.tsx, src/core/mock/docker-scenarios.ts | contracts | | opus | pending | | |

(Briefs written during phase 1.)

## Log

- Grill: Tailscale detection by local interface + SSH stderr; pause dialing while this Mac is offline; countdown + Retry now; Docker focal state with history link; launch allowlisted runtime apps.
