/**
 * The rule dialog's "Now" line: the current value of the series a rule
 * watches. The only part of the dialog that subscribes to the live store.
 */
import { formatAlertValue } from "@core/alert-values";
import { displayUnits } from "@core/format";
import type { UnitSettings } from "@core/generated/bindings";
import { sk } from "@core/series-key";
import type { ReactNode } from "react";
import { type HostLiveState, useHost } from "~/stores/host-store";
import { held, keysOf } from "~/stores/live-selectors";

/** Props of `NowLine`. */
export interface NowLineProps {
  metric: string;
  /** The watched series' labels; empty for every series ("Any"). */
  labels: Record<string, string>;
  op: "gt" | "lt";
  units: UnitSettings;
}

/**
 * The current value of one series, or for every series the one nearest the
 * threshold's side: the highest for above, the lowest for below. Null when
 * none has a value.
 */
function watchedValue(
  state: HostLiveState,
  { metric, labels, op }: Omit<NowLineProps, "units">
): number | null {
  if (Object.keys(labels).length > 0) return held(state, sk(metric, labels));
  const values = keysOf(state, metric)
    .map((key) => held(state, key))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return op === "gt" ? Math.max(...values) : Math.min(...values);
}

/** "Now 84%", re-rendering only when the shown value changes. */
export function NowLine({ units, ...watched }: NowLineProps): ReactNode {
  const value = useHost((state) => watchedValue(state, watched));
  return (
    <p className="figures m-0 text-muted-foreground text-small">
      Now {formatAlertValue(watched.metric, value, displayUnits(units))}
    </p>
  );
}
