# StatGlass 0.13.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

This release makes connection problems explain themselves. Remote hosts say exactly
why they can't connect and when StatGlass will try again, and the Containers page
tells you when Docker isn't running and can start it for you. It also adds a GitHub
star prompt and feedback entry points.

## Hosts that can't connect

- A host that can't be reached now names the cause: this Mac is offline, Tailscale is
  off on this Mac, Tailscale is on but the host isn't answering, the name isn't found
  on this network, SSH refused the connection, or there's no route to the host. Hosts
  with both LAN and Tailscale addresses report each route's cause.
- A host card that isn't live no longer shows charts that could pass for current
  data. It shows a reconnect panel instead: the cause, a countdown to the next
  attempt ("Next attempt in 12 s"), how long an attempt can take while one is running
  ("gives up after 10 s"), the attempt count and the last reading.
- **Retry now** skips the wait and shows "Trying…" until the attempt finishes.
  Automatic retries back off from 1 second to once a minute.
- When this Mac goes offline, StatGlass stops dialing, shows one notice on Hosts, and
  reconnects as soon as the network is back.

## Containers when Docker isn't running

- Instead of an empty chart stuck on "Loading recorded measurements…", Containers
  shows what's wrong: Docker Desktop (or OrbStack, Rancher Desktop or Colima) isn't
  running, the engine stopped, no engine is installed, several engines need a choice,
  the selected engine is gone, the socket refused access, or the engine is too old.
- **Open Docker Desktop**, **Open OrbStack** or **Open Rancher Desktop** starts the
  installed app, and the page goes live as soon as the engine answers. For Colima, the
  card offers `colima start` to copy.
- Saved container history stays one click away with **View saved history**.

## Feedback and a star prompt

- Feedback opens GitHub Issues from the Help menu, the menu bar, the dashboard sidebar
  and Settings, which can also copy non-personal system details for a report.
- After a day of use across a few sessions, a small card in the dashboard asks
  whether you'd like to star StatGlass on GitHub. You can snooze it once or dismiss it
  for good.
