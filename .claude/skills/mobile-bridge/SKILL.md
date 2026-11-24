---
name: mobile-bridge
description: Change what the StatGlass iPhone app can ask Rust for, end to end - the statglass-mobile facade, the generated types, the XCFramework, the statglass-native Expo module and MobileTransport - with the check to run at each step. Use when adding or changing a facade method, a streamed message, an exported record or a native module error, or when the app and Rust disagree about a type.
---

# Mobile bridge

The phone reaches Rust through five layers. A change goes through them in order, and each
layer has a check that must pass before the next one is worth building. Rules:
`.claude/rules/rust/mobile.md` and `.claude/rules/mobile/native-module.md`. Design: RFC
`plan/rfc-ios-app.md` 4.2 and 4.3.

```
crates/statglass-mobile (Rust, UniFFI)        command surface, scheduler, callbacks
  -> packages/core/src/generated/types.ts     specta export of the types it returns
  -> StatglassCore.xcframework + Swift bindings   scripts/mobile/build-rust-ios.sh
  -> apps/mobile/modules/statglass-native     Swift pipe: call(), events, signer, lifecycle
  -> apps/mobile/src/transport (MobileTransport)  implements the Transport contract
```

## 1. Rust facade

Decide first whether the behavior belongs in a shared crate (`statglass-session`,
`statglass-ipc`) so the desktop gets it too; the facade only exposes it. Then add or change
the method in `crates/statglass-mobile`:

- New data types go in `statglass-ipc` (or the facade, for phone-only types) and derive
  `specta::Type`; the result is JSON in `{ status, data | error }` with `CommandError`.
- The exported body runs inside `catch_unwind`; a panic maps to `CommandError::Internal`.
- Streams push through a UniFFI callback interface; never block the caller.

Check: `cargo test -p statglass-mobile` (and the shared crate you touched), `make
mobile-rust-check`, `make rust-check`, `make architecture-check`.

## 2. Types export

Register any new type with the one specta exporter, then run `make bindings`. It rewrites
`packages/core/src/generated/types.ts` and `src/desktop-transport/commands.ts`; never edit
either by hand (the write hooks block it).

Check: `make bindings-check` finds no drift after you commit, `bun run typecheck` passes,
and the diff to `types.ts` contains only the types you meant to change. An unrelated diff
means the generator moved; find out why before committing.

## 3. XCFramework and Swift bindings

```bash
scripts/mobile/build-rust-ios.sh
```

It builds `mobile-release` staticlibs for `aarch64-apple-ios` and `aarch64-apple-ios-sim`,
runs uniffi-bindgen for Swift and assembles the git-ignored XCFramework in the module. Both
outputs are generated: rebuild, never patch them.

Check: the script exits 0, and the generated Swift has the new function or record name.

## 4. Expo module (Swift)

Add the Swift side only as plumbing: forward `call(method, argsJson)` to the facade, forward
callback payloads as module events tagged with the subscription id, or add a typed module
error. Swift never reads fields out of metric JSON.

Check: `bun run --cwd apps/mobile expo prebuild --platform ios`, then `bun run --cwd
apps/mobile expo run:ios` builds and launches, or `make mobile-native-check` passes once phase 4
adds it (simulator `xcodebuild` build and native module tests). `make mobile-check` is JS-only
and never proves the Swift compiled.

## 5. MobileTransport

Implement the `Transport` method (or `Pick` of it) the screens use, with the same signature as
the desktop and the mock transport. Parse results into the generated types, map facade
errors to the `CommandError` union and module errors to `NativeError`, and turn a stream into
the same subscription shape `reduceLive` expects.

Check: the mock transport implements the same method with fixtures typed from
`types.ts` (update it in the same change, or demo mode and tests drift from the real app);
`bun run --cwd apps/mobile test -- src/transport`; `bun run test` for any core change.

## 6. Prove it end to end

Run the app in the simulator against a real host or the debug screen, per the
`ios-simulator` skill, and see the new data arrive. Report what you saw, not that the
build passed.

## When things disagree

- Swift crashes at load or a symbol is missing: the XCFramework is stale; rerun step 3.
- TypeScript and Rust disagree on a field: the export was not rerun or not committed; rerun
  step 2 and typecheck.
- A stream stops without an error: the callback lost its listener; the facade must end the
  subscription and log once, and the screen must show the status message it received.
