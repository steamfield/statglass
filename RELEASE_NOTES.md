# StatGlass 0.16.1

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

Remote Macs update in place with one click, Settings is split into tabs you can
search, and every module chart reads out its values on hover.

## Changes

- A remote Mac host updates in place from its card's "Update to X" action, the same
  as a Linux host, with a backup, an identity check and rollback, and it keeps its own
  menu-bar and login-item settings. Update all now includes Macs.
- Settings is split into tabs, with a search field (Cmd-F) that finds a setting on any
  tab and lets you change it in the results. A disabled setting links to the setting
  that turns it on, and the History tab opens on a meter of size on disk, projected
  size and limit.
- The CPU, GPU, Memory, Power & Sensors and Battery charts show a crosshair and the
  values at that moment on hover, like the Network and Disk charts.
- The Hosts page has Add to iPhone, which opens Update iPhone or Pair iPhone, and the
  Mac shows which hosts went to the phone after you approve one.
- Timeline's network lane draws upload and download as bars, and its top-processes
  readout keeps the last answer while the next one loads.

## Fixes

- A saved host reached over a Tailscale address is offered to the iPhone during
  pairing instead of being refused as a LAN address.
- The dashboard no longer slides the whole window up when the sidebar is scrolled to
  its end at short window heights.
