# StatGlass 0.14.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

You can now set your own alerts and have them reach your phone, and dashboard pages
settle in instead of flashing on.

## Changes

- Alerts has its own page in the sidebar. A rule is one sentence: a metric, a
  threshold and how long it has to hold, such as "Memory pressure above 80% for
  2 min". Pick from CPU, GPU, memory pressure, swap used, swap-out rate, the hottest
  sensor, fan speed, system power, battery charge and free disk space.
- Every alert becomes a Timeline event and a macOS notification, and goes to each
  destination you add: ntfy (the easy way to get it on your phone) or a webhook.
  Send test shows each destination working before you rely on it, and every
  destination shows its last delivery.
- A new built-in rule tells you when a saved host has been offline for five minutes,
  and again when it's back. Time your Mac spends asleep doesn't count.
- Opening a dashboard page fades the header and then each card into place one after
  another. It plays once when the page opens and never on live updates. Reduce Motion
  and Performance mode turn it off.

## Fixes

- `cookie` 0.18.3 for RUSTSEC-2026-0594.
