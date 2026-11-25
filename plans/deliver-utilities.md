# Plan: Utilities group and Disk space (D-153)

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.4/shared/scripts/plan_graph.py
Started: 2026-11-25. Timebox: none. Landing branch: deliver/utilities.
Gate: `bun run check && make rust-check bindings-check architecture-check` (about 110 s for `bun run check`). Filtered tests: `bun run test -- <path>`. Typecheck: `bun run typecheck`.
Runner: plain commands. Lanes run as Codex through foreman (owner's request), model gpt-6.2-sol.
Worktree setup: `bun install --frozen-lockfile`.

## Spec

The disk space report moves out of Disk's Activity | Space switcher into a Utilities group in
the dashboard sidebar, as its own page, Disk space. Disk keeps capacity and hands off to it.
Design and review: `plan/utilities.md`, D-153.

In scope:
- Sidebar: a fourth group, "Utilities", with a heading; one row, Disk space, shown when the
  build has the report (`edition.disk_space`) on any host; a running-scan mark on the row.
- Disk space page at `/dashboard/disk-space?vol=`: landing state leads with the kept
  boot-volume summary (D-132) with its age and a primary Scan again; without one, the boot
  volume's Scan is the one primary action. The volume list is a picker titled "Choose a volume".
- Disk: no view switcher; old `?view=space` links redirect (scaffold); Volumes card moves up
  under Disk I/O; each row links to Disk space; a volume under `LOW_DISK_FREE_BYTES` free says
  so inline.
- Overview Largest folders card: a visible link to Disk space; "Space" copy says Disk space.

Out of scope: Docker cross-link, built-in low-disk alert, clickable Timeline events, popover and
menu bar changes, scanner or accounting changes, sidebar keyboard shortcuts.

Assumptions: the Utilities heading uses the field-label style (11 px sentence case, D-101 bans
uppercase); the running-scan mark is a static live dot, no animation; the sidebar reads scan
state with the existing `useSpaceStatus`, which polls only while a scan runs.

Error model: unchanged from D-114/D-117. A host that can't answer space queries shows the
existing explanation on the Disk space page (`VolumeList`); the sidebar row's status query
failing shows no mark and no error. A failed reveal shows "Couldn't show this folder in
Finder." under the list (`useRevealHighlight`). A highlights query that fails on the landing
state is treated as no summary.

## Contracts (scaffold commit)

Rust: `statglass_schema::disk_space::LOW_DISK_FREE_BYTES: f32 = 20e9`, exported to TS as
`LOW_DISK_FREE_BYTES` (`@core/generated/types`); the `disk.free` alert default reads it.

Layout:

    src/app/router.tsx                              registers `disk-space`; wiring only
    src/app/routes/dashboard/route.tsx              shell: Disk space is a live-only page
    src/app/hooks/use-disk-space.ts                 space queries and actions shared by Disk space, Disk, Overview and the sidebar (moved from disk/_hooks); adds useSpaceHighlights, useRevealHighlight
    src/app/components/largest-folders.tsx          LargestFolderList, FolderRow, splitPath: the kept summary's rows (moved from folders-card)
    src/app/routes/dashboard/disk-space/route.tsx   reads `vol` and renders SpaceView
    src/app/routes/dashboard/disk-space/_components/space-*.tsx   the report UI (moved from disk/_components)
    src/app/routes/dashboard/disk-space/_lib/space.ts             report screen logic (moved)
    src/app/routes/dashboard/disk/route.tsx         Disk; redirects `?view=space`
    src/app/lib/time-ago.ts                         agoLabel ("3 days ago"), used by Disk space and the Overview card (moved from disk-space/_lib)
    src/app/components/ui/button.tsx                sets `data-variant` so tests can tell the primary button without class names
    packages/core/src/mock (scenario `disk-low-space`)   "/" has 12 GB free, the Data volume exactly LOW_DISK_FREE_BYTES

## Phases

### Phase 1: Utilities group with Disk space (MVP)

Demo: `bun run dev:fast`, open `/?route=/dashboard/overview`, see Utilities › Disk space in the sidebar, open it, see the last scan's folders, scan, watch the row's mark; open Disk and follow a volume's link.
Test cases: each lane writes its own tests from its brief (deviation from the scaffold-tests rule: the lanes are Codex runs that author tests with the code; the orchestrator reviews every test).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | `src/app/components/sidebar.tsx`, `src/app/components/sidebar.test.tsx`, `src/app/routes/dashboard/_components/live-sidebar.tsx`, `src/app/routes/dashboard/_components/live-sidebar.test.tsx`, `src/app/routes/dev/gallery/_sections/app-components.tsx` | contracts, `plan/design-system.md` | `src/app/components/sidebar.test.tsx`, `src/app/routes/dashboard/_components/live-sidebar.test.tsx` | codex | pending | | sidebar tests pass |
| b | M | `src/app/routes/dashboard/disk-space/`, `tests/e2e/disk-space.spec.ts` | contracts, `src/app/routes/dashboard/overview/_components/folders-card.tsx` | `src/app/routes/dashboard/disk-space/route.test.tsx` | codex | pending | | disk-space tests and e2e pass |
| c | M | `src/app/routes/dashboard/disk/`, `src/app/routes/dashboard/overview/_components/folders-card.tsx`, `src/app/routes/dashboard/overview/_components/folders-card.test.tsx` | contracts, `src/app/components/volume-table.tsx` | `src/app/routes/dashboard/disk/route.test.tsx`, `src/app/routes/dashboard/overview/_components/folders-card.test.tsx` | codex | pending | | disk and overview tests pass |

#### Lane a brief

- Goal: a labeled Utilities group at the bottom of the sidebar's entry groups with one row, Disk space, and a mark on that row while a space scan runs.
- Interface:
  - `SidebarProps.groups[]` gains `label?: string | undefined`.
  - `SidebarEntry` gains `busy?: { label: string } | undefined`.
  - `ICONS` gains `"disk-space": "M3 3h18v18H3zM13 3v18M3 13h10M13 9h8"` (a treemap: unequal blocks, unlike Overview's four squares).
  - `LiveSidebar` reads `useEdition()` (`~/hooks/use-edition`) and `useSpaceStatus(enabled)` (`~/hooks/use-disk-space`).
- Behavior:
  - A group with a `label` renders a heading above its rows, inside the group's top hairline: `<h2>` with `px-2 pb-1 font-normal text-label text-fg-faint` and `max-sm:sr-only`, sentence case as given (never uppercase, D-101). Its list is labelled by it (`aria-labelledby`), so `getByRole("list", { name: "Utilities" })` finds it. Groups without a label render exactly as today.
  - An entry with `busy` renders a decorative `StatusDot state="live"` in the value slot (right-aligned, same `min-w-9` slot, hidden value) and an sr-only `, <label>` like `attention` does. In the narrow layout (`max-sm`) the dot sits at the row's top right like the attention dot. No animation.
  - `LiveSidebar` adds `{ id: "utilities", label: "Utilities", entries }` after the tools group, with `entries` built in a `useMemo` keyed on `edition?.disk_space` and `busy` (as `tools` is), because `LiveSidebar` re-renders every tick and an inline array would defeat `SidebarGroup`'s `memo`; entries is `[{ id: "disk-space", href: "/dashboard/disk-space", label: "Disk space", icon: "disk-space", busy }]` when `useEdition()?.disk_space === true`, else empty, and an empty Utilities group is not passed at all. Shown for This Mac and remote hosts alike. `busy` is `{ label: "Scan running" }` while `useSpaceStatus(edition?.disk_space === true).data?.phase === "scanning"`.
  - The selection pill and arrow-key navigation include the new row (both already walk `[data-sidebar-item]`); `active` is the second path segment, so `/dashboard/disk-space` selects it.
  - Update the Sidebar JSDoc and the `groups` prop doc that say "three groups".
  - Dev gallery: the Sidebar fixture (`SIDEBAR` in `app-components.tsx`) gains the Utilities group with a busy Disk space row.
- Tests: `sidebar.test.tsx` adds: a labeled group renders its heading and a list named by it; unlabeled groups have no heading; a busy entry's link name ends with ", Scan running" and shows no value; End key focuses the last row of the last group. New `live-sidebar.test.tsx` (render `LiveSidebar` with `renderWithProviders` and the mock transport): Disk space link with href `/dashboard/disk-space` inside the Utilities list; with the `appstore` scenario no Disk space link and no Utilities list; after a scan starts, the link's name includes "Scan running" (start it through a mounted `useSpaceScan().start("/", [])`, for example a small harness component rendered beside `LiveSidebar` in the test: the status query does not poll while idle, so a scan started by calling the transport directly is never seen), and it drops after the mock scan finishes (`MOCK_SCAN_MS` with an injected clock, see `src/app/routes/dashboard/disk-space/route.test.tsx` `setup`).
- Decisions already made: the group is last among entry groups, after Settings; the row label is "Disk space"; no live value on the row; the running-scan mark uses the value slot (not the `attention` count badge, which means "needs you").
- Out of scope: keyboard shortcuts, any other utility, changing tools-group filtering, any route or page.
- Done when: `bun run test -- src/app/components/sidebar.test.tsx src/app/routes/dashboard/_components` and `bun run typecheck` pass; a screenshot of the sidebar at 220 px (dark and light) and narrow width is in the hand-off.

#### Lane b brief

- Goal: the Disk space page's first screen leads with the kept summary, has one primary action, and calls its volume list a picker.
- Interface: `SpaceView`/`HostSpace` in `space-view.tsx`; `SpaceVolumes` in `space-volumes.tsx`; `useSpaceHighlights`, `useRevealHighlight`, `useSpaceScan` from `~/hooks/use-disk-space`; `LargestFolderList` from `~/components/largest-folders`; `agoLabel` from `../_lib/space`; `useNow(MINUTE_MS)` from `~/hooks/use-now`.
- Behavior (only when `screen.mode === "volumes"`):
  - The landing waits for both the volumes query and the highlights query to settle (success or error) before rendering the card or the picker, showing the existing "Loading volumes…" status meanwhile, so the primary button never flips and the card never pushes the picker down. A failed highlights query counts as no summary and shows nothing about it.
  - Which volume leads: the last-scan card shows only when `vol` is null or is the boot volume (`is_boot`). When `vol` names another volume the host lists, the card is hidden and that row's Scan is the primary. Otherwise, with no card, the boot volume's Scan is the primary.
  - New component `_components/space-last-scan.tsx`, rendered above the picker when `useSpaceHighlights().data` is non-null and has folders: a `SectionCard` (accent `disk`, `variant="default"`) titled "Largest folders" whose header actions hold "Scanned <agoLabel>" (`text-label text-muted-foreground`, live via `useNow`) and a primary `Button size="sm"` "Scan again" that starts a boot-volume scan with the picker's current includes (the same `start` the picker uses, with the boot volume's mount). Body: one line "From the last scan of <summary.volume>. Scanning again rebuilds the full breakdown." then `LargestFolderList` of every summary folder, `onReveal` from `useRevealHighlight`, and its error as `InlineMessage tone="error"`. "Scan again" is disabled while busy.
  - A summary whose folders are empty, or a highlights query that is pending or failed, renders no last-scan card.
  - `SpaceVolumes` title becomes "Choose a volume" (its region label stays "Volumes to scan"). The intro sentence stays. Row buttons: the leading volume's Scan button (per the rule above) is `variant="default"` and the rest `outline`; when the card is shown, every row button is `outline`. Add a prop for this, named for what it means (e.g. `primaryMount: string | null`).
  - Nothing else on the page changes: the scan, report, breadcrumb, largest files, protected locations, messages.
- Tests (`route.test.tsx`, new cases): default mock shows the "Largest folders" card with "Scanned 3 days ago" and the fixture's folders, and "Scan again" there starts a boot scan (the report appears after `MOCK_SCAN_MS`); `disk-space-unscanned` scenario shows no card, and the Scan Macintosh HD button is the primary (`data-variant="default"`, which `Button` sets); `?vol=/Volumes/...` for the mock's external volume (find its mount in `packages/core/src/mock/disk-space.ts`) hides the card and makes that row's Scan primary; while highlights are pending neither the card nor the picker renders; reveal error shows the message (find how `folders-card.test.tsx` triggers a failed reveal); App Store (`appstore`) shows "Space reports are not available in this edition." and no card. Update existing tests only where the picker title changed.
- e2e `tests/e2e/disk-space.spec.ts`: keep every existing check passing on the new route; adjust selectors only where the landing changed (the card's "Scan again" and the report's "Scan again" never show together, and picker rows are named "Scan <volume>").
- Out of scope: sidebar, Disk page, Overview card, any change to scanning, report views, or hooks in `src/app/hooks/`.
- Done when: `bun run test -- src/app/routes/dashboard/disk-space`, `bun run typecheck` and `bunx playwright test tests/e2e/disk-space.spec.ts` pass; screenshots of the landing with and without a summary, dark and light, in the hand-off.

#### Lane c brief

- Goal: Disk shows capacity on its first screen and hands each volume off to Disk space, flagging nearly full ones; the Overview card's link is visible.
- Interface: `DiskActivity` and `AnalyzeLink` in `disk/route.tsx`; `VolumeTable`'s `action` slot (`~/components/volume-table`, read-only); `LOW_DISK_FREE_BYTES` from `@core/generated/types`; `formatBytes` from `@core/format`.
- Behavior:
  - Move the Volumes `SectionCard` to directly after the Disk I/O card (before the processes table and memory context). Nothing else in the page order changes.
  - The row's action slot holds two independent parts. The low-space flag is a capacity fact and always shows when the row's `freeBytes` is non-null and below `LOW_DISK_FREE_BYTES`, whether or not a link is available (App Store builds, hosts that can't answer, volumes not in the scan list, volumes query loading or failed): "<formatBytes(free)> free" in `text-warning-ink` with a lucide `TriangleAlert` before it (`icon-regular size-3`, `aria-hidden`; warnings carry icon and text, never color alone). Rows at or above the threshold, or with unknown free space, show no flag.
  - The link, `AnalyzeLink`, reads "See what's using space" (a quiet underlined text button, as today) and shows only for volumes the host can scan (existing rule). When the flag shows, the two sit on one line separated by " · ", and the link uses the normal foreground color instead of `text-fg-subtle`. Its accessible name is "See what's using space on <name>", where name is the scan volume's display name from `useSpaceVolumes` (`SpaceVolume.name`, "Macintosh HD"), not the row's mount point.
  - Remove the "Analyze space" wording everywhere in this route.
  - Overview `folders-card.tsx`: footer (when a summary exists and no scan is running) gains a `Link` "Open Disk space" to `/dashboard/disk-space?vol=/` beside "Re-run" (`text-label text-link hover:underline`); the empty state (no summary) gets the same link after "Run report"; the busy message reads "Another volume is being scanned in Disk space." with "Disk space" as the link. The title link stays.
- Tests: `disk/route.test.tsx` (or a new `disk/volumes.test.tsx` you own): the Volumes card comes right after Disk I/O in document order; a row link navigates to `/dashboard/disk-space?vol=/` (assert router location); `?view=space&vol=/` lands on `/dashboard/disk-space` with `vol=/`, and `?view=space` with no vol lands on `/dashboard/disk-space` with no search; App Store scenario has no link; with the `disk-low-space` scenario "/" shows "12 GB free" next to its link and the Data volume (exactly at the threshold) shows no flag; with `disk-low-space` plus `appstore`, "/" still shows "12 GB free" and no link. `folders-card.test.tsx`: "Open Disk space" link present with and without a summary, href `/dashboard/disk-space?vol=/`; busy copy says Disk space.
- Out of scope: the Disk space page, the sidebar, `VolumeTable` itself, any new metric or Rust change.
- Done when: `bun run test -- src/app/routes/dashboard/disk src/app/routes/dashboard/overview` and `bun run typecheck` pass; screenshots of Disk (top of page, with a low-space row) and the Overview card, dark and light, in the hand-off.

## Log

Plan critique (devil's advocate, opus), all eight accepted:
- Lane a test could not see a directly started scan: brief starts it through `useSpaceScan`.
- A non-boot `vol` led with the boot card: lane b rule for which volume leads.
- Low-space flag hidden whenever the link was: lane c renders the flag independently.
- Landing flicker while highlights load: lane b waits for both queries to settle.
- No mock data for low space: scaffold adds the `disk-low-space` scenario.
- Overview imported another route's `_lib`: `agoLabel` moved to `src/app/lib/time-ago.ts`.
- Utilities entries rebuilt every tick: lane a memoizes them; mark uses the value slot.
- Docs unowned, no `data-variant`, accessible name read "on /": docs stay with the orchestrator after phase 1; `Button` sets `data-variant`; lane c names the volume from `SpaceVolume.name`.
