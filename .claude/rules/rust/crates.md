---
paths:
  - "crates/**/*.rs"
  - "crates/**/Cargo.toml"
  - "src-tauri/**/*.rs"
  - "src-tauri/Cargo.toml"
  - "Cargo.toml"
---

# Rust Crate Rules

Architecture lives in `plan/architecture.md`.
Load the `ce:architecting-systems` skill before adding a crate, moving code between crates
or changing a dependency edge.

## Crate boundaries

The executable dependency policy is `scripts/architecture/crate-edges.json`.
`make architecture-check` compares normal, build and dev edges against Cargo metadata,
including inactive target-specific dependencies. Cargo alone prevents cycles; this check
also prevents an otherwise valid dependency from crossing an ownership boundary.

Current normal dependencies (left side depends on the right):

```
statglass-schema        -> none
statglass-proto         -> schema
statglass-collect       -> schema
statglass-store         -> schema
statglass-engine        -> schema, collect, store
statglass-session       -> schema, proto, store, engine
statglass-ssh           -> session
statglass-ipc           -> schema, store, engine, session (never remote)
statglass-remote        -> schema, proto, store, engine, session
statglass-remote-helper -> remote
statglass-notify        -> schema
statglass-query         -> schema
statglass-cli           -> query, schema
statglass-agent         -> schema, proto, store, engine, remote
statglass (src-tauri)   -> schema, proto, store, engine, remote, query, notify, ipc
statglass-mobile        -> schema, proto, store, engine, session, ipc, ssh (never remote)
```

The policy records dev edges separately (including store's protocol fixtures). Do not
copy a new dependency into the policy simply to silence a failure: explain the ownership
change in the implementation/decision record and test the boundary. Authorized refactors
can proceed autonomously within their agreed scope.

- `statglass-schema` is pure data: metric catalog, series keys (`metric_id` + labels), HostInfo,
  Capabilities, alert-rule data, the typed `Snapshot` view. No I/O, no platform code.
  The one non-data module is `statglass_schema::lock` (`LockExt`/`RwLockExt`, poison-recovering
  lock access, std only): every crate already depends on schema, so it lives here rather
  than adding a crate edge.
- `statglass-proto` is framing, codec (CBOR via `ciborium`), handshake and message types. It
  never touches the store or collectors.
- `statglass-collect` reads the OS. It knows nothing about storage or the UI.
- `statglass-store` knows SQLite and series layouts. It knows nothing about collectors.
- `statglass-engine` wires collectors to the store and bus through the `Ticker` and
  `PowerSignals` traits. It also owns `HistoryStore` lifecycle, generation-safe reader
  checkout/reset and persisted/recent history query merging.
- `statglass-session` is the client side of a remote session, shared by the desktop and
  the phone: `Endpoint`/`Target`, the `Dialer` seam, the handshake and N-target route
  race (`connect`), `SshSession`, `RemoteError` and `RemoteCommand` (phase 2 moves the
  codec, client calls, `HostClock`, `Mirror` and `RemoteSource` here too). It spawns no
  processes (its tokio has no `process` feature) and never depends on `statglass-remote`.
  Its `conformance` feature is the suite every dialer runs against a live host.
- `statglass-ssh` is the phone's russh dialer and its `Signer` seam (the Secure Enclave
  on a device). It depends on `statglass-session` only.
- `statglass-ipc` is the platform-neutral command layer and live producer shared by the
  desktop and the phone: `CommandError` and every `From<crate error>` it needs, the live
  registry, history and events queries, host vitals, connection status and process rows.
  It never depends on `statglass-remote`, `tauri` or `tauri-specta`: an error of a crate
  it cannot see (`AgentInstallError`) maps through a function in its caller. Every type it
  exposes derives `specta::Type` and reaches the bindings through the desktop's exporter.
- `statglass-remote` owns the OpenSSH dialer (`OpenSshDialer`), controller-side
  management (install, trust, control), host serving and `Mirror` storage
  synchronization; it re-exports the moved session names so its callers' imports do
  not change. `statglass-remote-helper` is the bundled stdio-to-local-socket bridge,
  not a collector agent.
- `statglass-agent` is the headless collector for hosts without the app (D-116): the engine,
  its own history and the metrics socket, plus the one-shot commands the controller runs
  over SSH. Install paths and unit text live in `statglass_remote::agent_layout`, shared
  with the controller.
- `statglass-notify` says what an alert rule and a fired alert say, and delivers a message
  to a destination through `/usr/bin/curl` (D-138). It depends on the schema only, so the
  headless agent can link it later. It is synchronous; callers run it off their thread.
- `statglass-mobile` is the iPhone app's UniFFI facade (`.claude/rules/rust/mobile.md`).
  It never depends on `statglass-remote`, which spawns processes and serves hosts;
  `statglass-session`, `statglass-ssh` and `statglass-ipc` (IPC types, live producer,
  `CommandError`) give it what it needs (RFC `plan/rfc-ios-app.md` 4.2).
- `src-tauri` is a thin shell: commands, windows, tray, settings ownership. Business logic
  that isn't Tauri-specific belongs in a crate, where it is testable without a webview.

Zero runtime dependencies (D-058): the app links only `/System/Library/` frameworks and
`/usr/lib/` libraries. A crate with a C library must use its bundled or vendored build
(like `rusqlite`'s `bundled`); never require a Homebrew or system install. Dev-only tools
(macmon for the accuracy script) stay optional. `make check-deps` enforces this on
the built binary locally before release.

## Data model rules

Series storage and explicit gaps are in CLAUDE.md and `data-boundary.md`. On top of those:

- The typed `Snapshot` is a view built from series and is never stored or synced.
- `host_id` (a persisted UUID) threads through every store call, command and channel.
- Exactly one process writes a given SQLite file.
- `seq` and millisecond timestamps are `i64` and stay below 2^53 (documented in
  `statglass-schema`) so they cross to TS as `number`.
