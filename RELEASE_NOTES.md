# StatGlass 0.15.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

Alerts now work on your Linux hosts too, disk space has its own place in the sidebar,
and your Macs and Linux hosts are ready for StatGlass for iPhone.

## Changes

- Linux agent hosts have their own Alerts page. Rules run on the host itself at full
  resolution, so they keep working when no window is open, and this Mac delivers them
  to your notifications, ntfy and webhooks as the host's history syncs in. Alerts that
  arrive late are grouped into one catch-up message per host. Linux hosts add memory
  pressure stall and the 5-minute load average to the metrics you can alert on. An
  older agent shows "Update the agent".
- Disk space moves out of Disk into a new Utilities group in the sidebar. It opens on
  the largest folders from your last scan. Disk now leads with Volumes under Disk I/O,
  links each volume to Disk space, and flags a boot volume that is running low.
- Settings has a Paired devices section for StatGlass for iPhone, a read-only viewer
  that is not out yet. Pairing shows a QR code; the phone gets its own key, limited
  to reading StatGlass data and revocable from this Mac, and nothing is paired until
  you approve the device on the host. StatGlass only ever edits the `authorized_keys`
  lines it added. Linux agents get the same pairing and `statglass-agent devices` to
  list and revoke phones.

## Fixes

- A mirrored host's history falls back to coarser data when minute history was never
  synced, instead of showing an empty range.
- A failed usage flush rolls back cleanly instead of leaving partial rows.
- The sidebar scrolls only its entries, and the host pill stays in place at every
  window width.
