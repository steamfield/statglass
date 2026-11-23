/**
 * How a group reads, shared by ordering, rows and the selection surface:
 * whether it expands, the process a group of one stands for, and the labels
 * its checkbox and context menu name it by.
 */
import { type ProcessTarget, targetKey } from "@core/process-selection";
import type { GroupRows } from "./types";

/** Whether a group has a chevron and lists members: `rows.expandable`, else a count over 1. */
export function canExpand<G, M>(rows: GroupRows<G, M>, group: G): boolean {
  if (rows.expandable) return rows.expandable(group);
  const count = rows.count(group);
  return count !== null && count > 1;
}

/** The same processes, by pid and start time, in any order. */
function sameProcesses(
  a: readonly ProcessTarget[],
  b: readonly ProcessTarget[]
): boolean {
  const keys = new Set(a.map(targetKey));
  return b.length === keys.size && b.every((p) => keys.has(targetKey(p)));
}

/**
 * The process a group of one reads as; undefined for any other group. A
 * count of one is not enough: usage counts only the processes above its
 * floor while the app's Quit acts on the live batch, so the group reads as
 * its member only when both act on the same processes. Otherwise the row
 * would name one process and quit another.
 */
export function soleMember<G, M>(
  rows: GroupRows<G, M>,
  group: G
): M | undefined {
  if (rows.count(group) !== 1) return undefined;
  const member = rows.members(group)[0];
  if (member === undefined) return undefined;
  return sameProcesses(rows.targets(group), rows.memberTargets(member))
    ? member
    : undefined;
}

/** A member's label: its name and pid, "Figma (1712)". */
export function memberLabel<G, M>(rows: GroupRows<G, M>, member: M): string {
  return `${rows.memberName(member)} (${rows.memberPid(member)})`;
}

/** A group's label: the app name, or its sole process's label for a group of one. */
export function groupLabel<G, M>(rows: GroupRows<G, M>, group: G): string {
  const sole = soleMember(rows, group);
  return sole === undefined ? rows.name(group) : memberLabel(rows, sole);
}
