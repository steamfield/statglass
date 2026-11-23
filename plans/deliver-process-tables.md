# Plan: one grouped, actionable process table everywhere

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/shared/scripts/plan_graph.py
Started: 2026-11-22. Timebox: none. Landing branch: deliver/process-tables (worktree /Users/riley/Projects/statglass-process-tables, cut from main bdf6ac94 plus cherry-picks of 9f3b206c app-group quit and a081b0d5 iOS RFC).
Gate: `make rust-check && make architecture-check && cargo test -p statglass && make bindings-check && bun run check` (frontend part 61s). Filtered tests: `bun run test -- <path>` and `cargo test -p statglass <name filter>`. Typecheck: `bun run typecheck` and `cargo check -p statglass --all-targets`.
Runner: plain commands. Rust commands in lane worktrees are prefixed with `CARGO_TARGET_DIR=/Users/riley/Projects/statglass-process-tables/target` so lanes share one build cache.
Worktree setup: `git merge --ff-only deliver/process-tables && bun install --frozen-lockfile && make stub-dist`.
Suppressions: biome-ignore, #[allow(, #[expect(
Manifests: Cargo.toml, package.json

## Spec

Every table in the dashboard that lists processes or apps (Processes, the CPU, GPU, Memory, Power, Disk and Network "by app" tables, live and recorded) shows the same thing: apps as rows that expand to their processes, with the same selection, Quit and Force Quit. Today Processes is flat, so quitting every Chrome or `node` process means searching first; recorded ranges and Network are read-only; Disk has its own table with a By app / By process toggle. One shared component replaces the five table implementations; each page supplies a data adapter and a column config.

In scope:
- `LiveProcess` (IPC) gains `app` (the app the process belongs to by the D-089 identity rule, the process name when unresolved, exactly the name per-app usage groups by) and `app_quit` (this process is among what Quit on its app acts on). Rust computes `app_quit` over the whole batch before the view is cut, with the same rule as `usage.rs::quit_pids`: the app's main executable alone when it is running, otherwise every member. The remote wire already carries `app`/`app_main`; no proto change.
- A shared `ProcessGroupTable` renders groups and members from a column config: name column with chevron, initial chip and "N processes"; config columns; optional client sort (group by aggregate, members by own value, then pid); Rust-ranked order when no sort is given; selection via the existing `ProcessSelectionSurface`/`ProcessSelectionRow`; hover actions; row hold; ArrowRight/ArrowLeft expand and collapse; optional virtualization at a fixed height; optional top-N limit with Show all; trailing rows (remainder rows, footnote); lazily rendered members for recorded ranges.
- Processes page groups by app. A group with one process reads as that process (its PID, no chevron). Group figures are member sums (CPU, memory, compressed, threads, wake-ups, energy, disk and network rates, GPU); ports are the sorted union; user is the members' user when they share one, else blank. Search matches the app name (all members shown) or a member's name, PID or port prefix (only matching members, group forced open). The footer counts processes and threads of what is shown.
- Module live tables (CPU, GPU, Memory, Power, Disk) keep their Rust-grouped windowed figures and move onto the shared component without behavior change.
- Disk loses its By app / By process toggle and its bespoke table: it always shows the grouped "Disk by app" table.
- Recorded ranges (HistoricalUsageCard) and every Network app table become actionable: an app row's targets are the running processes of the same app name that have `app_quit`; a recorded process row's target is the live process with the same pid and start time. Rows with no running match show their checkbox and actions disabled ("Not running").
- Network's "Apps, now" (history off) becomes the live grouped table with Down/Up/Total rate columns, top 12 groups by total. It asks for `FULL_TABLE` with network rates, since grouping a top-N batch would undercount groups and leave a group whose main was cut with no quit target. Every grouped live table asks for the full table for the same reason.
- Timeline's recorded apps table (`timeline/route.tsx`, a `HistoricalUsageCard`) becomes actionable along with the module pages; it shares the component.
- Live member rows whose host can open the process detail page link their name to `/dashboard/processes/:pid/:start` (`GroupRows.memberHref`), keeping the entry point Disk's process table had.
- Docs: a decision entry (D-137) in `plan/decisions.md`, v1 §4.14 amended, PROGRESS.md entry.

Out of scope: the Overview apps card, popover and widget `ProcessList` (render-only compact lists, read-only by the widget boundary); Timeline's crosshair tooltip process list; Containers cgroup table; any change to quit/force-quit dispatch, confirmation or Rust signalling; a flat mode toggle anywhere.

Assumptions: recorded tables map rows to running processes through a memoised map so a table whose rows did not change does not re-render each second; the e2e-perf gate (D-088) is run before merge. Groups start collapsed; expansion state is per table instance and not persisted; group rows on Processes sort by the aggregate of the sorted column; `app` names compare exactly (case-sensitive), as Rust groups them; mapping recorded rows to running processes needs the full process list, so tables that map ask for `FULL_TABLE` interest only while they are mounted and `useCanSignal()` is true (local Mac, not App Store edition).

Error model: no new failure paths reach the user. Dispatch, partial results, refusals (`refusal`), `PidReused`, `PermissionDenied` and lost connections stay with `useQuitFlow` and `QuitDialog`. A process that exits between selection and Quit is reported by the existing per-target results. A recorded row whose app has no running processes, or a live map that has not arrived yet, yields no targets: the row is not selectable and its actions are disabled with the "Not running" reason, never an error. Rust: an unresolved app falls back to the process name; `app_quit` never fails.

## Contracts (scaffold commit)

Layout:

    src-tauri/src/
      ipc.rs                     LiveProcess gains `app: String`, `app_quit: bool` (scaffold: fields + docs)
      app_quit.rs                NEW: the quit-target rule (generic) and the batch's quit set by app; pure
      live.rs                    builds LiveProcess rows from the quit set; only call sites change, it sits at its 750-line ceiling (lane 1a)
      usage.rs                   quit_pids delegates to app_quit (lane 1a)
    src/core/
      generated/bindings.ts      regenerated by `make bindings` in the scaffold
      process-groups.ts          NEW: groups live rows by app, sums figures, filters by search, maps app names to running quit targets; pure
      mock/fixtures.ts, mock/usage.ts, mock/processes.ts
                                 scaffold: mock rows carry app (APP_OF) and app_quit (`withAppQuit`, after the signalled filter)
    src/app/components/process-group-table/
      index.ts                   public exports only (scaffold)
      types.ts                   GroupColumn, GroupRows, ProcessGroupTableProps (scaffold, final)
      process-group-table.tsx    the component: ordering, expansion, selection wiring, body choice
      group-row.tsx              one group row: chevron, chip, name, count, cells, actions
      member-row.tsx             one member row
      use-group-order.ts         client sort, row hold and flattening into visible rows; pure core + hook
      live-columns.tsx           ProcessColumn ids and their GroupColumn<LiveGroup, LiveProcess> definitions
    src/app/routes/dashboard/processes/
      route.tsx, _lib/processes.ts   adopt the shared table (lane 1c)
    src/app/hooks/use-running-apps.ts  NEW in phase 3 scaffold: FULL_TABLE interest + runningByApp map

`src/app/components/process-table.tsx` and its two tests are deleted in phase 1 (lane 1c); `ProcessColumn`, `portsText` move to `live-columns.tsx`; `diskTotal`, `netTotal` live in `process-groups.ts` and the scaffold already repoints `detail-route.tsx`, `disk-processes.tsx` and `overview/_lib/card-props.ts` to them.

Core contract (`src/core/process-groups.ts`):

```ts
/** Figures of a live group: member sums; ports union; user when shared. */
export interface LiveFigures {
  cpu_pct: number | null; mem_bytes: number; compressed_bytes: number | null;
  threads: number; idle_wakeups_per_s: number | null; energy: number | null;
  disk_read_bps: number | null; disk_write_bps: number | null;
  net_rx_bps: number | null; net_tx_bps: number | null; gpu_pct: number | null;
  ports: number[] | null; user: string | null;
}
/** One app on the live table. */
export interface LiveGroup {
  key: string;                       // `app:${name}`
  name: string;                      // LiveProcess.app
  members: readonly LiveProcess[];   // every member, in input order
  shown: readonly LiveProcess[];     // members to list: all, or the search matches
  matchedInside: boolean;            // search matched members, not the app name
  quit: readonly LiveProcess[];      // members with app_quit
  figures: LiveFigures;              // over `shown`
}
export function groupLiveProcesses(rows: readonly LiveProcess[], query: string): LiveGroup[];
export function runningByApp(rows: readonly LiveProcess[]): ReadonlyMap<string, readonly LiveProcess[]>;
export function appQuitTargets(running: ReadonlyMap<string, readonly LiveProcess[]> | null, app: string): readonly LiveProcess[];
export function runningTarget(running: ReadonlyMap<string, readonly LiveProcess[]> | null, p: Pick<LiveProcess, "pid" | "start_time_us">): LiveProcess | null;
export function diskTotal(p: Pick<LiveFigures, "disk_read_bps" | "disk_write_bps">): number | null;
export function netTotal(p: Pick<LiveFigures, "net_rx_bps" | "net_tx_bps">): number | null;
```

Component contract: `src/app/components/process-group-table/types.ts` as committed in the scaffold is authoritative (it adds `memberHref`, `Expansion`, `afterMembers` and a `client` flag on `sort` over the sketch below). Sketch:

```ts
export type SortValue = number | string | null;
/** One column after the name column. */
export interface GroupColumn<G, M> {
  id: string;
  header: ReactNode;
  align: "left" | "right";
  /** Client-sort value; omit (both) to make the column unsortable. */
  groupValue?: (g: G) => SortValue;
  memberValue?: (m: M) => SortValue;
  group: (g: G) => ReactNode;
  member: (m: M) => ReactNode;
  className?: string;          // th and td classes (width, padding)
}
/** How the table reads groups and members from a page's data. */
export interface GroupRows<G, M> {
  groups: readonly G[];
  key: (g: G) => string;
  name: (g: G) => string;
  /** Count shown as "N processes"; 1 renders no chevron and no count. */
  count: (g: G) => number;
  members: (g: G) => readonly M[];
  /** Forced open, e.g. a search matched inside. */
  forcedOpen?: (g: G) => boolean;
  targets: (g: G) => readonly ProcessTarget[];
  memberKey: (m: M) => string;
  memberName: (m: M) => string;
  memberPid: (m: M) => number;
  /** Empty: the member is not running and offers nothing. */
  memberTargets: (m: M) => readonly ProcessTarget[];
  /** Dimmed member (exited). */
  memberMuted?: (m: M) => boolean;
}
export interface ProcessGroupTableProps<G, M> {
  rows: GroupRows<G, M>;
  columns: readonly GroupColumn<G, M>[];
  nameHeader: string;                         // "Process" or "App"
  ariaLabel: string;
  /** Client sort over `columns` ids plus "name"; omit for source (Rust-ranked) order. */
  sort?: { value: ColumnSort<string>; onChange: (next: ColumnSort<string>) => void };
  selectable: boolean;
  scopeKey?: string;
  /** Targets Command-A selects; defaults to every group's and listed member's targets. */
  allTargets?: readonly ProcessTarget[];
  /** Fixed viewport height in px: virtualizes rows and adds the selection bar space. */
  height?: number;
  freezeOrderOnHover?: boolean;
  /** Top N groups with a Show all / Show top N row; ignored when `searching`. */
  limit?: number;
  searching?: boolean;
  /** Rows after the groups (remainder rows, footnote), given the full colSpan. */
  after?: (colSpan: number) => ReactNode;
  /** Members rendered by the page (paged recorded processes). Not with `height`. */
  renderMembers?: (g: G, colSpan: number) => ReactNode;
  empty: ReactNode;
}
export function ProcessGroupTable<G, M>(props: ProcessGroupTableProps<G, M>): ReactNode;
```

Rust contract: `ipc::LiveProcess { …, app: String, app_quit: bool }`; `app_quit::quit_targets<P>(procs: &[P], running: impl Fn(&P) -> bool, main: impl Fn(&P) -> bool) -> Vec<usize>` returning indices; lane 1a adds `app_quit::live_quit_set(rows: &[ProcessSample]) -> HashSet<(i32, i64)>` (group by `app.unwrap_or(name)`, every row running, `main = app_main`).

## Phases

### Phase 1: grouped Processes page (MVP)

Scaffold: b1250f54
Demo: `bun run dev:fast`, open `/?route=/dashboard/processes`: apps are rows, Google Chrome / node expand to their processes, ticking the Chrome group selects its quit target, the selection bar's Quit opens the batch dialog; search "node" shows the node group open; sorting by Memory orders groups by summed memory.
Test cases:
- Rust: `app_quit::quit_targets` main running → only main; no main → all running; main exited → all running; none running → empty.
- Rust: `live_quit_set` groups by resolved app, falling back to process name; computed across the whole batch before the view's limit.
- Rust: usage `quit_pids` unchanged results (existing tests pass).
- core: groups by `app`, preserving first-seen order; single-member group; figures sum with null when every member is null and treat null as 0 otherwise; ports union sorted unique, null only when every member is null; user shared vs mixed → null.
- core: query blank → all groups, all shown; app-name substring (case-insensitive) → whole group, matchedInside false; member name / pid prefix / port prefix → only those members, matchedInside true, figures over matches; no match → group dropped.
- core: `quit` = members with app_quit; `appQuitTargets` by exact name, empty for unknown name or null map; `runningTarget` matches pid and start time, null when start differs.
- component: renders name column + config columns; group of 3 shows "3 processes" and a collapsed chevron; click chevron or ArrowRight expands, ArrowLeft collapses; forcedOpen groups render members; group of 1 has no chevron.
- component: client sort orders groups by groupValue, members by memberValue, ties by pid; clicking a header calls onSort; without `sort` source order is kept.
- component: non-client sort reports header clicks and keeps arrival order; group ties break by name; `memberHref` renders a link; owned expansion calls `onChange` and shows `afterMembers` rows.
- component: selectable: group checkbox selects `targets(g)`; member checkbox selects that member; Command-A selects allTargets; a member with no targets has a disabled checkbox; not selectable renders no checkbox column.
- component: `limit` shows top N and a "Show all N apps" row that toggles; searching ignores the limit; `after` rows render with the full colSpan; `empty` renders when there are no groups.
- component: with `height`, rows virtualize (a 300-group table renders far fewer rows than 300) and freezeOrderOnHover keeps group order while the pointer is in the table.
- route: Processes renders groups from the mock (Chrome helpers under Google Chrome, SourceKitService under Xcode); a group without a main selects every member, a bundled app selects only its main; a PID search opens the member's group; the footer counts shown processes and threads; column sets still switch columns and default sort; App Store edition shows no selection.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | S | src-tauri/src/app_quit.rs, src-tauri/src/live.rs | contracts, src-tauri/src/usage.rs | | sonnet | merged | deliver/process-tables-1a | cargo tests, clippy and architecture-check pass |
| b | S | src/core/process-groups.ts | contracts, src/core/usage-rows.ts | src/core/process-groups.test.ts | sonnet | merged | deliver/process-tables-1b | process-groups tests pass, typecheck clean |
| c | M | src/app/components/process-group-table/process-group-table.tsx, src/app/components/process-group-table/group-table-head.tsx, src/app/components/process-group-table/group-table-body.tsx, src/app/components/process-group-table/selection-rows.ts, src/app/components/process-group-table/types.ts, src/app/components/process-group-table/group-row.tsx, src/app/components/process-group-table/member-row.tsx, src/app/components/process-group-table/use-group-order.ts, src/app/components/process-group-table/live-columns.tsx, src/app/routes/dashboard/processes/route.tsx, src/app/routes/dashboard/processes/_lib/processes.ts, src/app/components/process-table.tsx, src/app/components/process-table.test.tsx, src/app/components/process-table-freeze.test.tsx, src/app/hooks/use-process-interest.ts, src/app/routes/dev/gallery/_sections/app-components.tsx | contracts, src/app/components/usage-apps-card.tsx, src/app/components/process-table.tsx | src/app/components/process-group-table/process-group-table.test.tsx, src/app/routes/dashboard/processes/route.test.tsx | opus | merged | deliver/process-tables-1c | component and route tests pass, typecheck and lint clean, screenshots compared |

#### Lane a brief

- Goal: Rust fills `LiveProcess.app` and `LiveProcess.app_quit` for local and remote rows, with the quit rule in one place.
- Interface: `src-tauri/src/app_quit.rs::quit_targets` is implemented in the scaffold and `usage.rs::quit_pids` already uses it; keep its four tests as they are. Add `pub fn live_quit_set(rows: &[statglass_collect::ProcessSample]) -> HashSet<(i32, i64)>` in the same file: group rows by `r.app.as_deref().unwrap_or(&r.name)`, apply `quit_targets` per group with `running = |_| true` and `main = |r| r.app_main`, return the `(pid, start_time_us)` of every target. Add tests for it in that file: a helper whose main is in the batch is not in the set; an app with no main puts every row in the set; a row with `app: None` groups under its own name. In `live.rs::on_processes`, compute the set from `rows` before `select_processes` and pass it to `live_process`, which fills `app` (the resolved name as an owned `String`) and `app_quit` (membership in the set). Replace the scaffold's placeholder values.
- Constraint: `src-tauri/src/live.rs` is at its 750-line ceiling in `scripts/architecture/rust-size-ceilings.txt`. Keep the logic in `app_quit.rs`; `live.rs` only gains call sites. Do not raise the ceiling.
- Decisions already made: Rust owns the rule (data boundary). No proto change: remote rows already decode `app`/`app_main` into `ProcessSample` and run through the same `on_processes`.
- Out of scope: any TypeScript, the mock (the scaffold did it), bindings (the scaffold regenerated them), process_signal.
- Done when: `CARGO_TARGET_DIR=/Users/riley/Projects/statglass-process-tables/target cargo test -p statglass app_quit usage live`, `make rust-check` and `make architecture-check` pass.

#### Lane b brief

- Goal: implement `src/core/process-groups.ts` per the contract and the scaffold's stub (`diskTotal`/`netTotal` are already done).
- Interface: the exported functions and types in the stub. Use `matchProcessQuery` from `@core/app-search`: call the matcher with `{ name: app }` for the app-name test and with each member (it reads `name`, `pid`, `ports`) for member matches, as `usage-rows.ts::usageRows` does.
- Behavior: exactly what `src/core/process-groups.test.ts` checks. Group order is first-seen order of `app`. `figures` are over `shown`. A summed figure is null only when it is null on every member; otherwise nulls count as 0. `mem_bytes` and `threads` are plain sums. `ports` is the sorted unique union, null only when every member's is null. `user` is the shared user or null.
- Decisions already made: no sorting here (the component sorts); pure functions, no React.
- Out of scope: sorting, selection, React.
- Done when: `bun run test -- src/core/process-groups.test.ts`, `bun run typecheck` and `bun run lint` pass.

#### Lane c brief

- Goal: build the shared `ProcessGroupTable` against the scaffold's `types.ts` and move the Processes page onto it, then delete the flat `ProcessTable`.
- Interface: `types.ts` and `index.ts` are fixed. Implement `process-group-table.tsx` (wiring: order, expansion, selection surface, choice of virtual or plain body), `group-row.tsx`, `member-row.tsx`, `use-group-order.ts` (pure ordering and flattening, plus the hold hook), and `live-columns.tsx` (exports `ProcessColumn`, `ProcessSort = ColumnSort<ProcessColumn>`, `portsText`, and `liveColumns(ids, ctx): GroupColumn<LiveGroup, LiveProcess>[]` with ctx `{ cpuBarMaxPct, memUnits, rateUnits }`). Reuse `ProcessSelectionSurface`, `ProcessSelectionRow`, `ProcessSelectionHead`, `SharedProcessActions`, `useRowHold`, `holdOrder`, `MeterCell`, `SortHeader` or its styling, `InitialChip`, `FullWidthRow`, `SELECTION_BAR_PX`, the `ui/table` primitives and `@tanstack/react-virtual` as the existing tables do. Pattern files: `usage-apps-card.tsx` (group rows, `parentKey` descriptors) and `process-table.tsx` (virtual body, `reveal` ref, hover hold, `data-testid="process-table-scroll"`).
- Behavior: everything `process-group-table.test.tsx` and `processes/route.test.tsx` check. Specifics the tests rely on: every body row (group or member) has `data-name` with its plain name and member rows have `data-pid`; the group checkbox is labelled `Select <group name>`, a member's `Select <name> (<pid>)`; the chevron is a button `Show|Hide <name> processes` with `aria-expanded`; a group of N>1 shows `N processes`; sortable headers are buttons whose name contains the header text, with `aria-sort` on the columnheader; the Show-all row's button reads `Show all N apps` / `Show top N`. Visible rows are flattened (group, then its members when open) and that list drives the selection descriptors (members carry `parentKey` = group key) and the virtualizer. With `sort.client`, groups order by value then name and members by value then pid, nulls last in both directions; without it, arrival order. With `expansion`, toggles call `expansion.onChange` and the table reads `expansion.open`. `afterMembers` rows render after an open group's members. A member with empty `memberTargets` gets a disabled checkbox and no actions. Processes page: group cells read `LiveGroup.figures`; PID shows the member pid for a one-member group, blank otherwise; Port `portsText(figures.ports)`; User `figures.user ?? ""`; `countLine` counts shown members; members link to the detail page through `memberHref` (`/dashboard/processes/<pid>/<start>`); `useProcessInterest` keeps the full-table views it has now. Move `use-process-interest.ts`'s type imports to `live-columns`. Update the dev gallery section that rendered `ProcessTable` to render the new table.
- Decisions already made: grouped only, no flat toggle; collapsed by default; hover and focus hold as today; a group's sort value is its aggregate; one commit per process frame (render-count test).
- Out of scope: module tables, Disk, Network, recorded tables (phases 2 and 3); new visual styles. Follow `plan/design-system.md` and match the existing usage table's group row (chevron, chip, muted count).
- Done when: `bun run test -- src/app/components/process-group-table src/app/routes/dashboard/processes`, `bun run typecheck`, `bun run lint` pass, and screenshots of Processes (light, dark) at `/?route=/dashboard/processes` are compared with the CPU page's app table, with differences named in the report.

### Phase 2: module live tables and Disk on the shared table

Demo: CPU, GPU, Memory, Power and Disk "by app" tables at 15m look and act as before, rendered by `ProcessGroupTable`; Disk shows "Disk by app" with no By process toggle; an expanded member's name opens its process detail page.
Depends on: phase 1
Test cases:
- `usage-apps-card.test.tsx` passes unchanged (ranked header, main-only quit, member selection, no-main group selects all, expand with exited members, refused processes, search opens the app, coverage notes, remote host note).
- Usage table: a running member's name links to `/dashboard/processes/<pid>/<start>`; an exited member has no link and no actions; remainder rows ("Other apps", "System and other") render after the groups with no checkbox; Show all toggles past 10 apps.
- Disk route: the default table is "Disk by app" with Read/Written/Total and selection; selecting the Xcode app selects its main only; brushing a range asks `query_usage_by_app` for disk and retitles the card to the range; there is no By app / By process button.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/app/components/usage-apps-card.tsx, src/app/components/app-table.tsx, src/app/routes/dashboard/disk/_components/disk-processes.tsx, src/app/routes/dashboard/disk/_components/disk-processes.test.tsx, src/app/routes/dashboard/disk/route.tsx | contracts, src/app/components/process-group-table/index.ts | src/app/components/usage-apps-card.test.tsx, src/app/routes/dashboard/disk/route.test.tsx | opus | pending | | usage and disk tests pass, screenshots compared |

#### Lane a brief

- Goal: `UsageAppsCard`'s live body renders through `ProcessGroupTable`, and Disk always shows the grouped usage table.
- Interface: build `GroupRows<UsageRow, ProcessUsage>` from `usageRows` (count = `app.processes.length`, members = `row.processes`, forcedOpen = `matchedInside`, targets = `row.quit`, memberTargets = running ? [p] : [], memberMuted = !running, memberHref = running ? detail path : undefined) and `GroupColumn`s from `config.columns` plus the share column. Rust ranks, so pass `sort` with `client: false` and the ranked column fixed descending (headers report but do not reorder, as now). Remainder rows and the footnote go through `after`; Show all through `limit={10}` and `searching`. Keep the coverage notes, GPU shortfall note and the brush scope. Remove the code in `usage-apps-card.tsx` and `app-table.tsx` this makes unused (`UsageAppRows`, `AppRows`, `ProcessRow`, `ActionsCell`, `UsageHead`/`usageColumns` if unused elsewhere; check with grep before removing an export).
- Disk: `DiskProcesses` renders `UsageAppsCard` with its disk config, no toggle; delete `DiskProcessList` and its helpers and the `disk-processes.test.tsx` cases that test the removed per-process view (keep any that still apply to the remaining component).
- Out of scope: `HistoricalUsageCard` (phase 3), Network, Processes.
- Done when: `bun run test -- src/app/components/usage-apps-card.test.tsx src/app/routes/dashboard/disk src/app/routes/dashboard/cpu src/app/routes/dashboard/memory src/app/routes/dashboard/gpu src/app/routes/dashboard/power`, typecheck, lint, and screenshots of CPU and Disk compared with phase 1's Processes.

### Phase 3: recorded ranges and Network become actionable

Demo: scroll CPU (or Timeline) back to a fixed range: rows of apps that are running now are selectable and quit the running app, others are disabled; Network by app rows select and quit; with Network history off, "Apps, now" is a grouped live table.
Depends on: phase 1
Test cases:
- `use-running-apps`: registers `FULL_TABLE` process interest only while `useCanSignal()` is true, returns null before the first batch, then a `RunningApps` map that keeps identity across batches whose rows did not change app membership.
- Recorded table: an app row whose name has running processes is selectable and its selection holds `appQuitTargets`; Quit sends `process_signal` for those pids only after the dialog; an app with no running process has a disabled checkbox and actions; expanding an app loads recorded processes through the existing paged query, a recorded process whose pid and start time are running is selectable, an exited one is muted and disabled; Load more appends members that then join selection and Command-A; the App Store scenario shows no checkboxes and asks for no full-table interest; previous-range comparison and the server sort keep working (header click re-queries, order follows the reply).
- Network live table: app rows select their running quit targets; "Other apps", "System and other" rows have no checkbox; sorting by Now and Total still works (client sort, ties by name); the brush selection still pins its app first.
- "Apps, now": groups live processes by app with Down, Up and Total; asks for `FULL_TABLE` with network rates; shows the top 12 groups by total; groups select and quit.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/app/components/historical-usage-card.tsx, src/app/components/historical-usage-processes.tsx | contracts, src/app/components/process-group-table/index.ts | src/app/components/historical-usage-card.test.tsx | opus | pending | | recorded table tests pass |
| b | M | src/app/routes/dashboard/network/_components/apps-card.tsx, src/app/routes/dashboard/network/_components/apps-now-card.tsx | contracts, src/app/components/process-group-table/index.ts | src/app/routes/dashboard/network/route.test.tsx, src/app/routes/dashboard/network/_components/apps-card.test.tsx | opus | pending | | network tests pass |

(Phase 3 briefs are written when phase 1 tags. `use-running-apps.ts` is small and shared by both lanes, so phase 3's scaffold implements it with its test.)

## Log
- Plan critique (devils-advocate, opus), all eight findings accepted: (1) "Apps, now" grouped a top-12 batch, now FULL_TABLE; (2) deleting process-table broke three importers, scaffold repoints them to `@core/process-groups`; (3) Disk's table held the only link to the process detail page, kept through `GroupRows.memberHref`; (4) `renderMembers` left paged recorded processes outside selection, replaced by controlled `expansion` plus `afterMembers` with members always from `rows.members`; (5) `sort` conflated sortable headers with client ordering, split by `sort.client`, group ties by name; (6) Timeline's recorded table becomes actionable too, named in scope, targets memoised, e2e-perf before merge; (7) mock `app_quit` went stale after a mock Quit, computed after the signalled filter in `processRows`; (8) `live.rs` sits at its 750-line ceiling, logic goes in `app_quit.rs`, `architecture-check` added to the gate. The mock work moved from lane 1a into the scaffold so the route tests have real groups.
- Lane 1/b merged. Accepted choices: `runningByApp` reuses the grouping helper; `runningTarget` scans members. Lane review: two cost findings rejected: `runningTarget` resolves only paged recorded processes of expanded apps (tens per tick, not 900), and `sumFigures`' ~20 passes total about 18k operations per tick over 900 rows; a single-pass rewrite would cost readability for no measurable gain. check-lane must use ec3d3dc5 (scaffold plus plan commit) as base, since lanes fast-forward to it.
- Lane 1/a merged. Accepted choices: `ProcessSample` imported via `statglass_engine`; test fixtures spell out every field. Lane review: three findings fixed: (1) an app with two running instances quit only the first main, `quit_targets` now returns every running main (usage `quit_pids` shares the rule); (2) the app-less grouping test could not tell its own name from a shared bucket, rewritten; (3) the dropped `live_process` doc came back when the builder moved to `LiveProcess::from_sample` in `live_process.rs`. Orchestrator fix: the scaffold's doc comments pushed `ipc.rs` past its 800-line ceiling, so `LiveProcess` moved to `src-tauri/src/live_process.rs`.
- Lane 1/c merged. Accepted choices: the table split into wiring, head, bodies, rows and `use-group-order`; a column with id `"pid"` suppresses the inline pid. Lane review: four findings fixed, one rejected. Fixed: (1) rows that arrived during a hold re-sorted every frame while the selection surface kept them in place, so the held order is now carried frame to frame; (2) a search-forced group showed a chevron whose toggle changed hidden state, so forced groups get no chevron and the count stays; (3) the virtual body sized every `afterMembers` item as one row, so `height` and `afterMembers` are exclusive in the props type; (4) a no-op release-on-unmount effect was removed. Rejected: (5) the `"pid"` column id convention, because the orchestrator owns the contract and column ids already carry meaning (`"name"` is the name sort). Orchestrator: removed the orphaned flat `filterProcesses`; matching stays covered by `app-search` and `process-groups` tests.
