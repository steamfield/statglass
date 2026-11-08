# StatGlass 0.8.1

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

This release turns the Overview into a page you can monitor from. Every card now shows
how its metric has moved over time, not just the reading this second, and a second row
adds battery, recent events and the apps that did the most work, filling the grid at
any window width.

## Overview

- Each module card draws its history over the dashboard's time range: CPU load, GPU
  utilization, memory pressure, system power, network and disk throughput. Pick the range
  from the new **5m**, **1h** and **More** control in the Overview header; it is the same
  range the module pages use, so a card opens its page on the same span.
- The current reading stays in each card's header. When you look at a fixed past range,
  it says "now" so it isn't mistaken for the chart's last value.
- Sleep periods show as hatched bands, as on the module pages.
- Memory pressure warnings appear as a chip in the Memory card's header.
- A **Battery** card shows charge over the range, time remaining or time to full, health,
  cycles and battery power. Macs without a battery don't get one.
- An **Events** card lists what the Mac's detectors noticed in the range: fans ramping up,
  thermal state changes, sustained heavy processes, power spikes and alert rules. Click
  one to open Timeline on that moment.
- An **Apps** card ranks the top apps by CPU, memory, GPU or energy over the range, from
  live readings for the last hour and recorded history beyond it.

## Smaller changes

- Network and Disk headers list upload or read first, matching their charts.
- The popover and the Battery page share one wording for time remaining and time to full.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
