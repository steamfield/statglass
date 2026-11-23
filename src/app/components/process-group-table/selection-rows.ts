/**
 * What the selection surface reads from the visible rows: one descriptor
 * per group and listed member, the targets Command-A selects, and a stable
 * identity for those targets across 1 Hz frames.
 */
import {
  type ProcessTarget,
  type SelectableProcessRow,
  targetKey,
  uniqueTargets,
} from "@core/process-selection";
import { useState } from "react";
import { groupLabel, memberLabel } from "./group-identity";
import type { GroupRows } from "./types";
import type { VisibleRow } from "./use-group-order";

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
        {
          key: row.key,
          label: groupLabel(rows, group),
          targets: rows.targets(group),
        },
      ];
    }
    const { member } = row;
    return [
      {
        key: row.key,
        parentKey: row.parentKey,
        label: memberLabel(rows, member),
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
