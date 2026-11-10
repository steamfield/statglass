# StatGlass 0.11.1

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

Charts now wait for their history before drawing data, and some animations that did
nothing in release builds work again.

## Charts

- Dashboard and popover charts show their frame straight away. A thin line scans along
  the baseline while history loads, and the data then settles in once, instead of
  charts filling in piece by piece.
- Hiding a window no longer leaves a chart's catch-up half finished.

## Fixes

- The tick scroll, number counts, the Disk space map and Timeline zoom animate in the
  released app. Their durations were read wrongly in production builds, so they
  snapped instead of moving.
- rusqlite is updated to 0.41.1 for RUSTSEC-2026-0459.

## Install and updates

- Installed copies update to 0.11.1 the usual way, from **Settings → General** or
  automatically. Updates are verified with StatGlass's own update signature before
  they install.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
