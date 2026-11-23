/**
 * The one table every process and per-app view renders: app groups that
 * expand to their processes, shared selection, Quit and Force Quit, client or
 * Rust-ranked order, row hold, and virtualization for the full process list.
 */
import type { ReactNode } from "react";
import type { ProcessGroupTableProps } from "./types";

/** Renders `rows` as app groups and member processes; see `ProcessGroupTableProps`. */
export function ProcessGroupTable<G, M>(
  props: ProcessGroupTableProps<G, M>
): ReactNode {
  void props;
  throw new Error("not implemented");
}
