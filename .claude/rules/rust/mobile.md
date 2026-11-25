---
paths:
  - "crates/statglass-mobile/**"
  - "crates/statglass-session/**"
  - "crates/statglass-ipc/**"
  - "crates/statglass-ssh/**"
  - "scripts/mobile/*.sh"
---

# Rust for iOS

`crates/statglass-mobile` is the iPhone app's Rust facade: a `staticlib` exported through
UniFFI, built for `aarch64-apple-ios` and `aarch64-apple-ios-sim` into an XCFramework by
`scripts/mobile/build-rust-ios.sh` (RFC `plan/rfc-ios-app.md` 4.2 and 4.3). The general
Rust rules (`crates.md`, `error-handling.md`, `platform.md`, `lints.md`) all apply.

## The facade

- Return every command result as JSON in the desktop's shape, `{ "status": "ok", "data" } | { "status": "error", "error": CommandError }`, so `MobileTransport` and the desktop map one error type.
- Wrap the body of every exported function and callback entry in `std::panic::catch_unwind` and map a panic to `CommandError::Internal`; a panic that crosses FFI is undefined behavior.
- Build iOS with the `mobile-release` profile (inherits release, `panic = "unwind"`), because the workspace release profile aborts and `catch_unwind` catches nothing there.
- Every type the facade returns lives in a crate the `src-tauri` specta exporter depends on (`statglass-ipc` from phase 3, `statglass-schema` or `statglass-proto` until then), derives `specta::Type` and is registered there, so it reaches `packages/core/src/generated/types.ts` through the one export. The facade defines none of its own (`src-tauri` has no edge to it), and there is never a second exporter.
- Keep the facade a shell: registry, session scheduler, mirror paths and policy, command surface. Session, sync and mirror logic belongs in the shared crates so the desktop runs the same code.
- Nothing exported blocks the caller: lifecycle calls return at once or are async, and streams push through UniFFI callbacks.

## Dependencies

- `statglass-mobile` never depends on `statglass-remote` (it spawns `/usr/bin/ssh` and serves hosts); `crate-edges.json` and an architecture-test fixture reject the edge.
- The SSH client is russh behind the dialer seam in `statglass-ssh`, pinned to an exact version (`=x.y.z`), because its `Signer` trait changes shape between releases; the signer test catches a bump that breaks it.
- Add an iOS-only dependency under `[target.'cfg(target_os = "ios")'.dependencies]` and an iOS exclusion under `cfg(not(target_os = "ios"))`, so desktop and Linux builds stay unchanged.

## Platform gating

- iOS is `unix` and `target_vendor = "apple"` but not `target_os = "macos"`; macOS private APIs stay `target_os = "macos"`.
- Engine's `disk_space` and `docker` modules and collect's Docker code are compiled out on `target_os = "ios"`; a new module that spawns processes or reads host paths gets the same gate.
- Clocks use `CLOCK_MONOTONIC_RAW` on Apple targets other than macOS; libc has no `CLOCK_BOOTTIME` there.
- Resolve hostnames through the system resolver (`getaddrinfo`) so NAT64 works on IPv6-only cellular; never parse or build IPv4 literals for dialing.

## Checks

- `make mobile-rust-check` runs `cargo check` and clippy `-D warnings` for `aarch64-apple-ios-sim`; run it after any change in the facade's dependency closure (schema, proto, store, engine, collect, session, ipc, ssh), since breakage often starts there.
- The Linux gate also builds `statglass-mobile`, but it never compiles the `target_os = "ios"` branches; only the iOS target check does.
- Record the `mobile-release` staticlib size when a change adds a dependency to the closure.
