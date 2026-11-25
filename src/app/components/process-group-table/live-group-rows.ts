import type { LiveProcess } from "@core/generated/types";
import type { LiveGroup } from "@core/process-groups";
import { targetKey } from "@core/process-selection";
import type { GroupRows } from "./types";

/**
 * How a live grouped table (Processes, Network's Apps, now) reads app groups: the members listed are the
 * search matches, a search that matched inside opens the group, Quit on the
 * app acts on the members Rust marked `app_quit`, and each member links to
 * its detail page, whose back link returns to `back` (this page's path and
 * query).
 */
export function liveGroupRows(
  groups: readonly LiveGroup[],
  back: string
): GroupRows<LiveGroup, LiveProcess> {
  const backQuery = `?back=${encodeURIComponent(back)}`;
  return {
    groups,
    key: (g) => g.key,
    name: (g) => g.name,
    count: (g) => g.members.length,
    members: (g) => g.shown,
    forcedOpen: (g) => g.matchedInside,
    targets: (g) => g.quit,
    memberKey: targetKey,
    memberName: (p) => p.name,
    memberPid: (p) => p.pid,
    memberHref: (p) =>
      `/dashboard/processes/${p.pid}/${p.start_time_us}${backQuery}`,
    memberTargets: (p) => [p],
  };
}
