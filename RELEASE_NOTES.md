# StatGlass 0.11.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

The Overview's machine header now shows load, thermal state and your network
addresses, and every dashboard page keeps its header in view as you scroll.

## Dashboard

- Each page's header stays pinned to the top while the page scrolls, and you can drag
  the window by it.
- The Overview machine header adds load averages (1, 5 and 15 minutes), the thermal
  state when it reaches Serious or Critical, and a Network row with the local and
  public addresses. Click an address to copy it. Showing the public address means the
  Overview now asks ipify for it while it is open, as the Network page already did.
- The laptop drawing in that header is redrawn.
- Overview charts draw their lines at half weight, so detail shows at card size. Module
  pages are unchanged.

## Install and updates

- Installed copies update to 0.11.0 the usual way, from **Settings → General** or
  automatically. Updates are verified with StatGlass's own update signature before
  they install.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
