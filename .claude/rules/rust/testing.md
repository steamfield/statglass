---
paths:
  - "crates/**/*.rs"
  - "src-tauri/**/*.rs"
---

# Rust Testing

The root `testing.md` covers commands, the mocking boundaries (fake `Collector`, `Ticker`
and `PowerSignals`, real SQLite), timing fakes and flake triage. This file covers what's
specific to the Rust suite.

- Unit tests in `#[cfg(test)] mod tests` next to the code; integration tests in
  `crates/<crate>/tests/`.
- Codec changes need the round-trip and version-skew test (old fixture decoded by new code
  and the reverse).
- Tests that need real hardware are `#[ignore]` with a reason, and run by hand.
- In `statglass-agent`, every test that can take the installation or history lock (an
  flock) starts with `if crate::test_support::reexec_for_lock_test() { return; }`. A
  sibling test's fork holds the locked descriptor until its exec. Never include
  production source into an integration test with `#[path]`; use the crate's lib target.
