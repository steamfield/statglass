/**
 * The contract every grouped process table is built from: how a page's data
 * reads as app groups and member processes (`GroupRows`), the columns after
 * the name column (`GroupColumn`), and the table's options. Pages supply
 * these; `ProcessGroupTable` owns ordering, expansion, selection and actions.
 */
import type { ProcessTarget } from "@core/process-selection";
import type { ReactNode } from "react";
import type { ColumnSort } from "~/components/data-table";

/** What a client-sorted column sorts by; null sorts last in either direction. */
export type SortValue = number | string | null;

/** One column after the name column. */
export interface GroupColumn<G, M> {
  /** `"pid"` marks a PID column: member names then leave out their inline pid. */
  id: string;
  header: ReactNode;
  align: "left" | "right";
  /**
   * The header is a sort button. Defaults to whether the column has a
   * `groupValue` or `memberValue`; a page whose rows Rust ranks (non-client
   * sort) sets it without either value.
   */
  sortable?: boolean;
  /** Client-sort value of a group row. */
  groupValue?: (group: G) => SortValue;
  /** Client-sort value of a member row, used inside its group. */
  memberValue?: (member: M) => SortValue;
  group: (group: G) => ReactNode;
  member: (member: M) => ReactNode;
  /** Classes for the header and every cell of the column (width, padding). */
  className?: string;
}

/** How the table reads groups and members out of a page's data. */
export interface GroupRows<G, M> {
  groups: readonly G[];
  /** Stable across frames: the selection, expansion and hold key. */
  key: (group: G) => string;
  name: (group: G) => string;
  /**
   * Shown as "N processes"; null when unknown (a recorded app before its
   * processes load), which shows no count. A group of one reads as its
   * process: its member's name, link and pid.
   */
  count: (group: G) => number | null;
  /** Has a chevron and lists members when open. Defaults to a count over 1. */
  expandable?: (group: G) => boolean;
  /** The members to list when the group is open. */
  members: (group: G) => readonly M[];
  /** Open regardless of the reader's toggle, e.g. a search matched inside. */
  forcedOpen?: (group: G) => boolean;
  /** What the group row selects and quits; empty disables it. */
  targets: (group: G) => readonly ProcessTarget[];
  /**
   * Why a group with no targets offers nothing ("Not running"): shown where
   * its actions would be. Ignored while the group has targets.
   */
  unavailable?: (group: G) => string | undefined;
  memberKey: (member: M) => string;
  memberName: (member: M) => string;
  memberPid: (member: M) => number;
  /**
   * Extra identity for the member's pid, e.g. when a recorded process
   * started: its pid's tooltip, and read after the pid by screen readers.
   */
  memberDetail?: (member: M) => string | undefined;
  /** The process detail page for a member; its name renders as a link to it. */
  memberHref?: (member: M) => string | undefined;
  /** What the member row selects and quits; empty when it is not running. */
  memberTargets: (member: M) => readonly ProcessTarget[];
  /** Why a member with no targets offers nothing, as for `unavailable`. */
  memberUnavailable?: (member: M) => string | undefined;
  /** Dim the member (it has exited). */
  memberMuted?: (member: M) => boolean;
}

/**
 * Sortable headers over `columns` ids plus `"name"`. With `client`, the table
 * orders rows itself: groups by value then name, members by value then pid,
 * missing values last either way. Without it, the header only reports the
 * reader's choice and rows keep the order they arrive in (Rust ranks them).
 */
export interface ClientSort {
  value: ColumnSort<string>;
  onChange: (next: ColumnSort<string>) => void;
  client: boolean;
  /** The name header is a sort button too. Defaults to true. */
  nameSortable?: boolean;
}

/** Expansion owned by the page, when it loads members for open groups. */
export interface Expansion {
  open: ReadonlySet<string>;
  onChange: (open: ReadonlySet<string>) => void;
}

interface TableOptions<G, M> {
  rows: GroupRows<G, M>;
  columns: readonly GroupColumn<G, M>[];
  /** Header of the name column: "Process" or "App". */
  nameHeader: string;
  ariaLabel: string;
  /** Omit for unsortable headers and arrival order. */
  sort?: ClientSort;
  /** Omit and the table keeps its own expansion, collapsed to start. */
  expansion?: Expansion;
  /**
   * Checkbox gutter, selection bar and Quit actions. Null while that is not
   * known yet (`useCanSignalSettled`): the table renders nothing rather than
   * add the gutter under the reader a moment later.
   */
  selectable: boolean | null;
  /** Selection resets when it changes (another range, another host). */
  scopeKey?: string;
  /** What Command-A selects; defaults to every group's and listed member's targets. */
  allTargets?: readonly ProcessTarget[];
  /** Hold group order while the pointer is over the table. */
  freezeOrderOnHover?: boolean;
  /** Show the first `limit` groups and a Show all row; ignored while `searching`. */
  limit?: number;
  searching?: boolean;
  /** Rows after the groups (remainder rows, a footnote), given the full colSpan. */
  after?: (colSpan: number) => ReactNode;
  /** One full-width row while there are no groups. */
  empty: ReactNode;
}

/**
 * `height` virtualizes rows at a fixed row height, so it cannot take
 * `afterMembers`, whose rows can be absent or several per group.
 */
export type ProcessGroupTableProps<G, M> = TableOptions<G, M> &
  (
    | {
        /** Viewport height of the scrolling body in px: virtualizes rows. */
        height: number;
        afterMembers?: never;
      }
    | {
        height?: undefined;
        /**
         * Rows after an open group's members that are not processes: a loading or
         * error line, a note, Load more. Members themselves always come from
         * `rows.members`, so selection, keyboard and Command-A cover them.
         */
        afterMembers?: (group: G, colSpan: number) => ReactNode;
      }
  );
