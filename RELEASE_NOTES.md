# StatGlass 0.9.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

StatGlass is now signed with a Developer ID and notarized by Apple. Download the DMG,
drag StatGlass into Applications and open it: macOS asks once whether to open an app
from the internet, and there is no trip to System Settings to allow it.

## Install and updates

- The app, its SSH helper and the `statglass` command-line tool are signed with a
  Developer ID under Apple's hardened runtime, and the app and DMG carry Apple's
  notarization ticket, so they pass Gatekeeper offline too.
- Installed copies update to 0.9.0 the usual way, from **Settings → General** or
  automatically. Updates are still verified with StatGlass's own update signature
  before they install.
- Because the app's signature changed, macOS may ask again for a permission you
  granted an earlier version, such as notifications. Allow it once more.
- Releases are now built, signed and notarized from the tagged source on GitHub's
  build machines.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
