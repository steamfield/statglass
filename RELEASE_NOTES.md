# StatGlass 0.10.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

StatGlass is now signed with a Developer ID and notarized by Apple. Download the DMG,
drag StatGlass into Applications and open it: macOS asks once whether to open an app
from the internet, and there is no trip to System Settings to allow it. The Overview
also gains three cards and lets you choose which cards it shows.

## Overview

- **Largest folders** lists the five biggest folders worth cleaning up on your startup
  disk, such as Xcode build data, simulators, caches, `node_modules`, downloaded models
  and Downloads. Scanning the disk is heavy, so it only runs when you press
  **Run report**. The last report stays on the card with how old it is and a
  **Re-run** button. Click a folder to show it in Finder.
- **Containers** appears when Docker monitoring is on. It shows the five containers
  that peaked highest over the dashboard's time range, by CPU or memory, and each row
  opens that container.
- **Other hosts** appears once you have saved a remote host. It shows each host's live
  CPU and memory, or why it isn't connected. Click a host to switch the dashboard to it.
- The new **Overview cards** menu in the Overview header hides and shows cards. Your
  choice is saved.

## Install and updates

- The app, its SSH helper and the `statglass` command-line tool are signed with a
  Developer ID under Apple's hardened runtime, and the app and DMG carry Apple's
  notarization ticket, so they pass Gatekeeper offline too.
- Installed copies update to 0.10.0 the usual way, from **Settings → General** or
  automatically. Updates are still verified with StatGlass's own update signature
  before they install.
- Because the app's signature changed, macOS may ask again for a permission you
  granted an earlier version, such as notifications. Allow it once more.
- Releases are now built, signed and notarized from the tagged source on GitHub's
  build machines.
- 0.9.0 was tagged but never published; its changes are part of this release.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
