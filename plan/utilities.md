# Utilities and the disk space report

Status: Done, 2026-11-25 (D-153), built by `plans/deliver-utilities.md`; revised after a devil's-advocate design review and
the owner's direction on a Utilities group (record at the end). Amends where the D-114
space report lives; the scanner, its accounting and its retention are unchanged. Plan for
the report: [disk-space-report.md](disk-space-report.md).

The dashboard sidebar gains a **Utilities** group. The disk space report moves out of
Disk's Activity | Space switcher and becomes its first row, **Disk space**. Disk keeps
capacity and hands off to it.

## Placement rule

Features live where they belong. A monitoring view belongs to its module page. An action
on something a page already shows (quitting a process, cleaning up a Docker image) belongs
on that page. A utility, meaning a tool the user runs on demand that is not part of
watching a module, and that no existing page owns, goes in Utilities, one row per tool.

The disk space report is a utility: a scan reads a whole volume, so it runs only when the
user asks (D-114). It was put under Disk because it concerns disks, and it got buried
there: a `SegmentedControl` in the top right of the Disk header that reads as a third
range toggle beside 5m / 1h / 15m, an Analyze link on the last card of the page, and a
hover-only title link on the Overview's Largest folders card (D-132).

### Audit of existing features

| Feature | Where it is | Placement |
| ------- | ----------- | --------- |
| Disk space report | Disk › Space | Utilities › Disk space |
| Docker storage and cleanup (D-107) | Containers › Storage & cleanup | Stays: Docker resources tied to container identity, owned by Containers |
| Quit or force quit a process | Processes rows | Stays: an action on a row |
| CLI and agent skill install, iPhone pairing | Settings | Stays: setup, not a tool |
| Timeline CSV export | Timeline | Stays: an action on what Timeline shows |

Developer cache cleanup (DerivedData, simulators, `node_modules`, Homebrew cache), if built,
is part of Disk space, not its own row. Battery health and network tests, if built, belong
on their module pages.

## Experience

### Sidebar

A fourth sidebar group, after the tools group (Hosts, Processes, Containers, Alerts,
Settings), under a "Utilities" heading, with one row per utility. Rows carry their own icon
and no live value.

- The heading is new to the sidebar, whose groups are separated by `--color-border-subtle`
  with no labels (`design-system.md`, Sidebar row). It uses the existing caption type and
  muted color. In the narrow, icon-only sidebar the heading is hidden like the row labels
  and the group keeps its separator. Checked by screenshot at 220 px and narrow, in light
  and dark.
- The group is omitted when it has no rows for the build (App Store builds omit the
  report), so no empty heading shows.
- Row **Disk space** at `/dashboard/disk-space?vol=`. The scan, treemap, table, breadcrumb
  and largest files are today's `SpaceView`, unchanged.
- **Gating.** Shown whenever the build has the report (`edition.disk_space`), for This Mac
  and every remote host, as the Disk switcher is gated today. Whether a remote host can
  answer is not known until it is asked (D-117 has no capability bit, D-152), so the page
  explains it, as `VolumeList` already does ("Update the agent", not available on this
  host), instead of the row appearing late or flickering on host switch.
- **Running scan.** A scan keeps running after the user leaves the page, so while it runs
  the row shows it (a still dot in the row's value slot; the `attention` count means "needs you", which a
  running scan does not).

### Ownership between Disk and Disk space

Disk owns capacity: how full each volume is and how that changes over time. Disk space
owns contents: what fills a volume. Disk's Volumes card hands off to Disk space on every
row. Disk space never shows a second capacity table titled Volumes; its volume list is a
picker ("Choose a volume") and may keep each row's usage bar as context.

### Disk space landing state

With no scan in memory:

- **When a boot-volume summary exists** (D-132 `space-highlights.json`): its largest
  folders with their age ("Scanned 2 days ago") and a primary "Scan again" action. The
  detailed tree is gone after the dashboard closes (D-114), so the copy says the summary is
  from the last scan and a scan rebuilds the detail.
- **With no summary:** one sentence on what the report does and that StatGlass reads only
  and changes nothing, one primary "Scan Macintosh HD" action for the boot volume, and the
  other volumes below it as secondary choices.

Page header: title "Disk space", the chosen volume as the subtitle, no window control.

### Disk

The Activity | Space control goes, so Disk has one view and its header keeps only the
window control. The Volumes card moves to directly under the Disk I/O card. Each row's
Analyze link opens Disk space for that volume, with copy that says what it does ("See
what's using space").

When a volume's free space is below the low-space threshold, its row says so inline
("12 GB free · See what's using space") with the link emphasized. The threshold is a
Rust-published constant, not a TS number (`rules/data-boundary.md`); the `disk.free` entry
in `ALERT_METRICS` already publishes a 20 GB default.

`?view=space` links redirect to `/dashboard/disk-space` with the same `vol`.

### Overview Largest folders card

The title link stays, and the card gains a visible "Open Disk space" link (in its footer
when it lists folders, beside "Run report" in its empty state). Copy that names "Space"
(`folders-card.tsx`) is updated.

## Scope

Must:

- Utilities sidebar group with its heading; Disk space row and route, gated on edition
  only; unsupported hosts explained on the page.
- Landing state: remembered summary first, one primary scan action otherwise.
- Remove the Disk switcher; Volumes under the I/O card; rows link to Disk space; low-space
  prompt from a Rust-published threshold.
- `?view=space` redirect; Overview card's visible link and copy.

Should:

- Running-scan state on the Disk space row.

Won't (this plan):

- Moving Docker storage, process actions or Settings content into Utilities (audit above).
- Popover or menu bar changes.
- Changes to scanning, accounting, retention or deletion (D-114, D-132 stand).
- Sidebar keyboard shortcuts. ⌘1 to ⌘9 are proposed in the design system but not built;
  if built, bind them to entry ids, since absent modules drop out of the sidebar.

### Not decided here

- **Docker disk image cross-link.** A treemap tile for a Docker or OrbStack disk image
  should link to Containers › Storage & cleanup. `SpaceNode` carries no category (only
  `SpaceHighlight` does, D-132) and the client may not infer one from paths, so this needs
  an optional `category` on `SpaceNode` in Rust, which is D-117 wire vocabulary and needs
  codec skew fixtures.
- **Prompts outside the dashboard.** There is no built-in free-disk-space alert, Timeline
  event overlays are not clickable, and desktop notifications can't route a click
  (`notify.rs`). A built-in low-disk rule (a D-138 amendment) and clickable Timeline events
  are the candidates.

## Docs to update when this lands

- `disk-space-report.md` § Entry point and the Disk route (switcher, empty state, the
  Overview disk card opening Activity).
- D-132 (the Overview card starts "the Space view's own scan").
- `design-system.md`: screen inventory (Disk route, a Disk space route), the Sidebar row
  spec (a fourth group with a heading).

## Decision

A two-way door: no series, storage or identity change, and nothing on the wire. Recorded
as D-153.

## Review record

Devil's-advocate design review, 2026-11-25, with the `ce:design` lens. Every finding was
checked against the code and accepted:

| Finding | Change |
| ------- | ------ |
| Links outside Disk rested on an alert that isn't built in and Timeline events that aren't clickable | Moved to Not decided; added the Disk low-space prompt |
| Docker link assumed `SpaceNode` categories that don't exist and touched the wire | Cut to Not decided with its Rust and wire cost named |
| The new page's empty state was weaker than the Overview card | Landing state leads with the remembered summary; one primary scan action |
| Capacity shown in two places under two rows | Ownership rule; the Disk space list is a picker |
| Gating on a capability the client can't check | Edition-only gating; page explains unsupported hosts |
| Overview card already links (title, hover-only) | Visible link and copy fix |
| ⌘1 to ⌘9 not built and positional | Removed; Won't with id-based note |
| A running scan becomes invisible off the page | Running-scan state on the row |
| "Storage" implies delete actions and collides with Containers | Row named "Disk space"; landing sentence says StatGlass changes nothing |
| Doc ripple not listed | Docs to update section |

Owner direction, same day: organize by where features belong, with a Utilities group for
on-demand tools no existing page owns, one row per tool. This replaced the earlier
proposal of a Storage row in the tools group and dropped its success-measurement section.
