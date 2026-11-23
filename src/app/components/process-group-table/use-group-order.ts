/**
 * The order a grouped process table shows its rows in. Pure functions sort
 * groups and members by a client sort and flatten open groups into the one
 * list of visible rows that the body, the virtualizer and the selection
 * surface all read. `useGroupOrder` adds the row hold: while the reader is in
 * the table, rows keep the place they had and newcomers go last.
 */
import { holdOrder } from "@core/held-order";
import {
  type ProcessTarget,
  type SelectableProcessRow,
  targetKey,
  uniqueTargets,
} from "@core/process-selection";
import { useState } from "react";
import { useRowHold } from "~/components/data-table";
import type { ClientSort, GroupColumn, GroupRows, SortValue } from "./types";

/** One row of the flattened body: a group, one of its members, or its trailing rows. */
export type VisibleRow<G, M> =
  | {
      kind: "group";
      key: string;
      group: G;
      /** More than one process: it has a chevron and can open. */
      expandable: boolean;
      open: boolean;
    }
  | { kind: "member"; key: string; parentKey: string; member: M }
  | { kind: "after"; key: string; group: G };

/** What ordering and flattening read from the table's props. */
export interface OrderSource<G, M> {
  rows: GroupRows<G, M>;
  columns: readonly GroupColumn<G, M>[];
  sort: ClientSort | undefined;
  /** Group keys the reader opened. */
  open: ReadonlySet<string>;
  /** Show only the first N groups; null shows every group. */
  limit: number | null;
  /** Add an `after` row under each open group's members. */
  withAfter: boolean;
}

/** The sort id that orders by the name column. */
export const NAME_COLUMN = "name";

/**
 * Compares two sort values in `dir`, with missing values last either way.
 * Returns 0 for a tie so the caller can break it.
 */
export function compareSortValues(
  a: SortValue,
  b: SortValue,
  dir: "asc" | "desc"
): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }
  const order =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b));
  return dir === "asc" ? order : -order;
}

function sortColumn<G, M>(
  columns: readonly GroupColumn<G, M>[],
  by: string
): GroupColumn<G, M> | undefined {
  return columns.find((c) => c.id === by);
}

/**
 * A group's sort value: its aggregate, except that a group of one reads as
 * its process and sorts by the member's own value.
 */
function groupSortValue<G, M>(
  source: OrderSource<G, M>,
  group: G,
  by: string
): SortValue {
  const { rows } = source;
  if (by === NAME_COLUMN) return rows.name(group);
  const column = sortColumn(source.columns, by);
  const only = rows.count(group) === 1 ? rows.members(group)[0] : undefined;
  if (only !== undefined && column?.memberValue) {
    return column.memberValue(only);
  }
  return column?.groupValue?.(group) ?? null;
}

function memberSortValue<G, M>(
  source: OrderSource<G, M>,
  member: M,
  by: string
): SortValue {
  if (by === NAME_COLUMN) return source.rows.memberName(member);
  return sortColumn(source.columns, by)?.memberValue?.(member) ?? null;
}

/** Groups in client-sort order (value, then name), or as they arrived. */
export function sortGroups<G, M>(source: OrderSource<G, M>): readonly G[] {
  const { sort, rows } = source;
  if (!sort?.client) return rows.groups;
  const { by, dir } = sort.value;
  return [...rows.groups].sort(
    (a, b) =>
      compareSortValues(
        groupSortValue(source, a, by),
        groupSortValue(source, b, by),
        dir
      ) || rows.name(a).localeCompare(rows.name(b))
  );
}

/** A group's members in client-sort order (value, then pid), or as listed. */
export function sortMembers<G, M>(
  source: OrderSource<G, M>,
  group: G
): readonly M[] {
  const { sort, rows } = source;
  const members = rows.members(group);
  if (!sort?.client) return members;
  const { by, dir } = sort.value;
  return [...members].sort(
    (a, b) =>
      compareSortValues(
        memberSortValue(source, a, by),
        memberSortValue(source, b, by),
        dir
      ) || rows.memberPid(a) - rows.memberPid(b)
  );
}

/** Whether a group lists its members: it has several, and is open or forced open. */
export function isGroupOpen<G, M>(
  source: OrderSource<G, M>,
  group: G
): boolean {
  const { rows, open } = source;
  if (rows.count(group) <= 1) return false;
  return (rows.forcedOpen?.(group) ?? false) || open.has(rows.key(group));
}

/**
 * The rows the body shows, top to bottom: each group, then its members and
 * trailing rows when open. With `held` keys, groups and members keep those
 * positions and rows not in it go after them.
 */
export function flattenGroups<G, M>(
  source: OrderSource<G, M>,
  held: readonly string[] | null
): VisibleRow<G, M>[] {
  const { rows } = source;
  const sorted = sortGroups(source);
  const groups = held ? holdOrder(sorted, held, rows.key) : sorted;
  const listed = source.limit === null ? groups : groups.slice(0, source.limit);
  return listed.flatMap((group) => groupRows(source, group, held));
}

function groupRows<G, M>(
  source: OrderSource<G, M>,
  group: G,
  held: readonly string[] | null
): VisibleRow<G, M>[] {
  const { rows } = source;
  const key = rows.key(group);
  const open = isGroupOpen(source, group);
  const head: VisibleRow<G, M> = {
    kind: "group",
    key,
    group,
    expandable: rows.count(group) > 1,
    open,
  };
  if (!open) return [head];
  const sorted = sortMembers(source, group);
  const members = held ? holdOrder(sorted, held, rows.memberKey) : sorted;
  return [
    head,
    ...members.map((member) => ({
      kind: "member" as const,
      key: rows.memberKey(member),
      parentKey: key,
      member,
    })),
    ...(source.withAfter
      ? [{ kind: "after" as const, key: `${key}:after`, group }]
      : []),
  ];
}

/**
 * Selection descriptors for the visible rows, in the same order; a member
 * names its group as parent so the selection keeps it under the group.
 */
export function selectionRows<G, M>(
  visible: readonly VisibleRow<G, M>[],
  rows: GroupRows<G, M>
): SelectableProcessRow[] {
  return visible.flatMap((row): SelectableProcessRow[] => {
    if (row.kind === "after") return [];
    if (row.kind === "group") {
      const { group } = row;
      return [
        { key: row.key, label: rows.name(group), targets: rows.targets(group) },
      ];
    }
    const { member } = row;
    return [
      {
        key: row.key,
        parentKey: row.parentKey,
        label: `${rows.memberName(member)} (${rows.memberPid(member)})`,
        targets: rows.memberTargets(member),
      },
    ];
  });
}

/** What Command-A selects by default: every group's targets and every listed member's. */
export function visibleTargets<G, M>(
  visible: readonly VisibleRow<G, M>[],
  rows: GroupRows<G, M>
): ProcessTarget[] {
  const groups = rows.groups.flatMap((group) => rows.targets(group));
  const members = visible.flatMap((row) =>
    row.kind === "member" ? rows.memberTargets(row.member) : []
  );
  return uniqueTargets([...groups, ...members]);
}

/** Same processes in the same order, with the fields the selection refreshes from. */
function sameTargets(
  a: readonly ProcessTarget[],
  b: readonly ProcessTarget[]
): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i];
      return (
        q !== undefined &&
        targetKey(p) === targetKey(q) &&
        p.name === q.name &&
        p.refusal === q.refusal &&
        p.running === q.running
      );
    })
  );
}

/**
 * `targets`, keeping the previous array while it lists the same processes.
 * The selection surface refreshes its selection whenever this array changes
 * identity, which would cost a second commit on every 1 Hz frame.
 */
export function useStableTargets(
  targets: readonly ProcessTarget[]
): readonly ProcessTarget[] {
  const [stable, setStable] = useState(targets);
  if (sameTargets(stable, targets)) return stable;
  setStable(targets);
  return targets;
}

/** How the reader holds the order: hover (when asked for) and the owner's reasons. */
export interface HoldOptions {
  freezeOrderOnHover: boolean;
  /** The selection surface holds: a selection, a pending quit, hover. */
  when: boolean;
}

/**
 * The visible rows with the row hold applied. A hold takes a snapshot of the
 * order it starts on; a new sort takes a fresh one, so a header click while
 * hovering re-sorts at once. Spread `holdProps` on the element around the rows.
 */
export function useGroupOrder<G, M>(
  source: OrderSource<G, M>,
  options: HoldOptions
) {
  const { held, holdProps, release } = useRowHold({
    pointer: options.freezeOrderOnHover,
    when: options.when,
  });
  const live = flattenGroups(source, null);
  const resetKey = source.sort
    ? `${source.sort.value.by}:${source.sort.value.dir}`
    : "";
  const [snapshot, setSnapshot] = useState<{
    resetKey: string;
    keys: readonly string[];
  } | null>(null);
  let next = snapshot;
  if (!held) next = null;
  else if (snapshot?.resetKey !== resetKey) {
    next = { resetKey, keys: live.map((row) => row.key) };
  }
  // Updating state during render re-renders before commit: still one commit.
  if (next !== snapshot) setSnapshot(next);
  const visible = next ? flattenGroups(source, next.keys) : live;
  return { visible, holdProps, release };
}
