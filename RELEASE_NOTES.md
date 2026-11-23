# StatGlass 0.13.2

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

Every process table now works the same way, and you can quit apps from any of them.

## Changes

- Processes groups processes by app. Chrome, node or python sit under one app row
  that expands to list its processes, and selecting the app row selects everything
  Quit on that app acts on, so you no longer have to search to select them all.
- The process tables on CPU, GPU, Memory, Power, Disk, Network and Timeline can now
  select, Quit and Force Quit, with the same rows, keys and selection as Processes.
  Apps shown from recorded history act on what is running now, and say "Not
  running" when nothing they name is.
- Disk by app no longer has a separate By process view; expand an app to see its
  processes.

## Fixes

- On ranges longer than an hour, the "by app" table no longer goes blank for a moment
  every 10 seconds, and keeps the apps you opened and your selection.
- The host menu in the sidebar opens below its button instead of over the logo.
