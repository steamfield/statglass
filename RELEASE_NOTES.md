# StatGlass 0.12.1

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

This release overhauls remote-host disconnection and error states, adds a direct
Linux agent restart from host settings, and recovers automatically from transient
history-store open failures.

## Remote error states

- Disconnected remote hosts now explain **why** the connection failed (timeout,
  unreachable, SSH authentication, host key verification, stopped agent, protocol
  mismatch, or changed identity), list the saved LAN and Tailscale routes, and show
  contextual `@steamfield/ui` clips with an automatic offline icon fallback.
- Connection notices sit below the sticky page header so the top bar stays aligned
  with the sidebar. When mirrored history exists on disk (`synced_through_ms`), the
  notice renders as a compact banner and keeps saved history crisp and interactive,
  with one-click **Jump to saved history**, **Switch to This Mac**, **Retry
  connection**, **Turn on connection**, and collapsible **Technical details** with
  **Copy details**.
- Pages with no saved history yet — or live-only pages like Processes, Containers, and
  Disk › Space — show a focused error card instead of dimmed empty widgets.
- The sidebar footer and Overview pill now report accurate remote connection status
  (`Offline`, `Reconnecting…`, `Auth failed`, `Agent stopped`, `Connection off`)
  instead of `Stale · no new data` or `Connecting`.

## Hosts & history recovery

- Linux host settings include a **Restart** action in the **Agent on this host** panel
  to reset and restart `systemd` over SSH without leaving StatGlass.
- Both the Mac app and the Linux agent now retry once a minute when the history store
  fails to open for a retryable reason (such as a full disk or file lock), resuming
  recording automatically once the condition clears instead of requiring a reset.

## Install and updates

- Installed copies update to 0.12.1 the usual way, from **Settings → General** or
  automatically. Updates are verified with StatGlass's own update signature before
  they install.
- Update your remote hosts to 0.12.1 from **Hosts** to pick up automatic history
  reopen recovery on Linux agents.
