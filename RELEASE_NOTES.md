# StatGlass 0.16.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

Your Macs and Linux hosts now serve everything StatGlass for iPhone needs, and remote
hosts show their network addresses on this Mac.

## Changes

- Network, Overview and the popover's Network card show a monitored remote host's own
  interface, local and public IP, the same way they show this Mac's. A VPN is no
  longer labelled `en0`. When the read fails the card says "Addresses unavailable",
  and an older host shows its interface alone. Each host decides whether its public
  IP is looked up.
- Hosts answer history queries from StatGlass for iPhone, with range totals for the
  module pages, so the phone's charts and pages work against this release. A 0.15.0
  host still streams live data to the phone but asks to be updated for history.
- When you pair an iPhone with this Mac, the phone can offer to add the Mac's other
  saved hosts. For each one you choose, this Mac installs the phone's restricted key
  over its own SSH access. Hosts it can't hand over (a `ProxyJump` or `ProxyCommand`
  alias, a literal LAN address, or no stored host key) are listed on the phone with
  the reason.
- Linux agents get the same history and address answers.

## Fixes

- A window's charts wait at most 10 seconds for the history refill after the stream
  connects, instead of skipping the loading state or waiting on detail that never
  turns on.
- A remote stream catches up within a bounded window after a stall, rebinds at once
  when its host changes, and shows Reconnecting until a fresh frame arrives.
- Remote history reads stay within the requested range and keep slots after a gap.
