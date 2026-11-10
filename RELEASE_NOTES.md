# StatGlass 0.12.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

The Hosts page is now a monitoring dashboard: every host gets a card with its recent
CPU and memory, its vitals, its StatGlass version and any test run holding it.

## Hosts

- Each host is a card with the last 10 minutes of CPU and memory, and its load (against
  its core count), memory pressure, boot disk and network rate. Gaps in a host's
  history stay gaps.
- A host that's offline, turned off, failing to connect, re-identified or too old to
  read says so on its card, with the action that fixes it: Retry, Turn on, Re-pair or
  Update.
- A disk running low shows a warning on the host's card.
- Each card shows the host's StatGlass version and whether it's the latest. Updating a
  Linux host shows its progress as it goes (uploading, installing, restarting,
  reconnecting), and a failed update says so and offers Retry.
- Reinstalling StatGlass on a Mac you already added now updates it in place, keeping
  its name, history and settings. It used to be refused as already added.
- When an [rr](https://rr.steamfield.io) run holds a host, its card shows the command,
  the Mac that started it, the other hosts in the same run and how long it has run.
  Hosts without rr show nothing extra.
- Host settings are split into Connection, History on this Mac, Updates on this host
  and Remove, and say which changes save on the host right away.
- Long names, system details and error messages end in an ellipsis and show in full
  on hover or focus.

## Background work

- Polling stops whenever a StatGlass window is hidden, minimized, covered or the
  display sleeps, on every page, not only Hosts.
- The Hosts page's extra work (recent history, and rr checks every minute over SSH)
  runs only while that page is on screen.

## Install and updates

- Installed copies update to 0.12.0 the usual way, from **Settings → General** or
  automatically. Updates are verified with StatGlass's own update signature before
  they install.
- Update your remote hosts to 0.12.0 to get their full vitals. Older hosts still show
  CPU, memory, network and pressure, with the rest marked not available.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
