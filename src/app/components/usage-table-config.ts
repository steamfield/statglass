/**
 * How a module page configures its per-app usage card: the key Rust ranks
 * by, the title noun, the accent, the figure columns and the footnote.
 */
import type { UsageKey } from "@core/generated/bindings";
import type { UsageFigures } from "@core/usage-rows";
import type { ReactNode } from "react";
import type { Accent } from "~/widgets/lib/accent";

/** What a cell can read: any row's figures, and an app's average footprint. */
export type UsageCells = UsageFigures & { mem_avg_bytes?: number };

/** One figure column of the usage table. */
export interface UsageColumn {
  /** Column head ("Avg CPU"). */
  label: string;
  format: (u: UsageCells) => string;
  /** The table is ranked by this column (Rust sorts by the page's key). */
  ranked?: boolean;
}

/** A module page's usage card. */
export interface UsageTableConfig {
  by: UsageKey;
  /** "CPU": the title reads "CPU by app, last 15 minutes". */
  noun: string;
  accent: Accent;
  columns: readonly UsageColumn[];
  /** Under the rows: what the figures are and what they leave out. */
  footnote: ReactNode;
}
