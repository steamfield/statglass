---
title: StatGlass for iPhone
description: Set up StatGlass for iPhone, read its privacy policy, or get support.
group: Privacy
order: 41
---

StatGlass for iPhone shows live metrics and charts from your computers, including CPU, memory, network and disk activity. To monitor a computer, you need StatGlass running on a Mac or `statglass-agent` running on a Linux host. Tap **Try demo hosts** on the welcome screen to explore the app with simulated data and no host connection.

## Pair a host

1. On a Mac, enable **Remote Login** in System Settings and **Allow remote monitoring** in StatGlass Settings. In **Paired devices**, click **Pair iPhone**. On Linux, run `~/.local/bin/statglass-agent pair` as the user who installed the agent, or `sudo /usr/local/bin/statglass-agent pair` for a system install.
2. On the iPhone, tap **Add a host**, then **Scan QR**. If you're using the full pairing text printed by the Linux agent, choose **Paste code**, paste the text and tap **Preview host**.
3. Check the host details and tap **Confirm** on the iPhone. Compare the short code on both devices before approving on the Mac or Linux host. The iPhone gets read-only access to the host's monitoring data.

See [how to install StatGlass on a Mac](/docs/install) or [set up a Linux host](/docs/linux-hosts#installing-the-agent).

### Hosts from your Mac

When you pair with a Mac, StatGlass offers to add the Mac's saved remote hosts that have **Connect automatically** turned on in the Mac's host settings. To add hosts you save later, click **Add to iPhone** on the Mac's Hosts page, or open **Settings → Paired devices → Update iPhone**. On the iPhone, open **Settings → Hosts → Update from Mac**, scan the code, then review the list and tap **Apply updates**.

The Mac can only share hosts the iPhone can connect to and verify over SSH. It skips hosts in these cases.

- The SSH alias uses `ProxyJump` or `ProxyCommand`. The iPhone connects directly and can't use those proxy settings.
- The SSH alias uses a private or link-local IP address directly and has no Tailscale route. The iPhone may be on a different network. Tailnet IP addresses in `100.64.0.0/10` (the Tailscale `100.x` range) or `fd7a:115c:a1e0::/48` count as Tailscale routes.
- The Mac has no trusted host key in its SSH known-hosts files, such as `~/.ssh/known_hosts`. The iPhone needs that key to verify the host's identity.
- The SSH alias can't be resolved, or its LAN and Tailscale aliases use a different user or port. The iPhone saves one user and port per host.

For a host skipped for a proxy, remove `ProxyJump` and `ProxyCommand` from every alias the host uses on the Mac, for example by pointing its Tailscale alias straight at the host's Tailscale address. For a host skipped for a LAN-only address, give it a Tailscale address or alias. Then update the iPhone again. For a host with no known key or an alias that can't be resolved, fix it on the Mac, or pair it directly: run Pair iPhone on that Mac, or `statglass-agent pair` on that Linux host (see [Pair a host](#pair-a-host)).

## Privacy

The iPhone app sends no data to the developer. It has no StatGlass account, analytics or ads. Live metrics and chart history come directly from your hosts over encrypted SSH. Your hosts keep the history. The iPhone holds readings temporarily in memory for display and saves no metric history.

The app saves your host connection details and settings on your iPhone. The private SSH key stays in the Secure Enclave on an iPhone and in the Keychain on the iOS Simulator.

When you request pairing, the app sends your iPhone's name, model and public SSH key to the host. If you approve pairing, the host saves the name and public key to let the iPhone connect again. The host also records when the iPhone last connected.

When you open a host's Network screen, the host may contact `api.ipify.org` to look up its own public IP address. The SSH connection carries the result back to the iPhone.

### Permissions

- **Camera** is used only to scan the pairing code shown on your Mac or server. The Linux agent also prints pairing text you can paste without camera access.
- **Local Network** is used only to connect over SSH to hosts on the same network.
- **Face ID** unlocks StatGlass when you turn on the optional **App Lock**.

You can change these permissions in your iPhone's Settings.

### Remove a host or revoke access

On the iPhone, open **Settings → Hosts**, select the host and tap **Remove**. In the confirmation sheet, tap **Remove _host name_**. This removes the saved connection from the iPhone and leaves history on the host.

To revoke the iPhone's key on a Mac, open StatGlass **Settings → Paired devices**, click **Revoke** next to the iPhone and confirm. The Mac also queues revocation on the hosts it shared with the iPhone.

On Linux, use the same agent path and account as when you paired. Run the agent with `devices` to find the iPhone's tag, then with `devices revoke TAG`, replacing `TAG` with that tag.

Revoking removes the saved name and public key from the host and blocks new connections with that key. An open connection can stay active until the iPhone disconnects.

This website has its own analytics. See the [website privacy details](/docs/privacy#this-website).

## Support

For help with pairing, bug reports or privacy questions, open a [StatGlass issue on GitHub](https://github.com/steamfield/statglass/issues).
