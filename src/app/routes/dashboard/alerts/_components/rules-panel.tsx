/**
 * The Alerts page's Rules panel: the built-in rules, then the user's
 * threshold rules, one switch row each.
 */
import { availableMetrics, lastFiredByRule, ruleSummary } from "@core/alerts";
import type {
  AlertRule,
  AlertSettings,
  UnitSettings,
} from "@core/generated/bindings";
import { type ReactNode, useMemo } from "react";
import { useNavigate } from "react-router";
import { SettingsPanel } from "~/components/settings-row";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { useHostClock } from "~/lib/host-clock";
import { useSettings } from "~/stores/settings-store";
import { useRecentAlerts } from "../_hooks/use-recent-alerts";
import { useSeriesKeys } from "../_hooks/use-series-keys";
import { lastFiredText, windowAroundAlert } from "../_lib/last-fired";
import { RuleRow } from "./rule-row";

/** Props of `RulesPanel`. */
export interface RulesPanelProps {
  /** Open the editor on a custom rule ("Edit <rule name>"). */
  onEdit: (rule: AlertRule) => void;
}

/** Rust always writes `alerts`; `undefined` is only the serde default's type. */
const DEFAULT_ALERTS: AlertSettings = {
  hot_process: false,
  thermal_serious: false,
  host_offline: false,
  rules: [],
};

const NOT_MEASURED = "Not measured on this Mac";
const NEVER_FIRED = "Never fired";

/**
 * A `SettingsPanel` titled "Rules". The two built-in rows come first
 * ("A process above 200% CPU for 5 minutes", "Thermal state Serious or
 * worse") and write `{ alerts: { hot_process } }` / `{ alerts: {
 * thermal_serious } }`. Each custom row's label is the rule name; its sub
 * line is the sentence when the name differs from it, then "Last fired
 * <relative time>" opening the Timeline at that alert, "Never fired", or
 * "Not measured on this Mac" when no live series has its metric. Its switch
 * (named by the rule name) writes the whole rules list with that rule's
 * `enabled` flipped. Does not re-render on a live tick.
 */
export function RulesPanel({ onEdit }: RulesPanelProps): ReactNode {
  const alerts = useSettings((s) => s.alerts ?? DEFAULT_ALERTS);
  const units = useSettings((s) => s.units);
  const write = useWriteSettings();
  const measured = useMeasuredMetrics();
  const { alerts: recent } = useRecentAlerts();
  const lastFired = useMemo(() => lastFiredByRule(recent), [recent]);
  if (alerts === null || units === null) return null;
  // Absent from a settings file written before custom rules: none.
  const rules = alerts.rules ?? [];

  const setEnabled = (id: string, enabled: boolean) =>
    write({
      alerts: {
        rules: rules.map((r) => (r.id === id ? { ...r, enabled } : r)),
      },
    });
  return (
    <SettingsPanel
      title="Rules"
      after={
        <p className="m-0 text-label text-muted-foreground">
          Switching a rule on sends a test notification, so macOS can ask for
          permission now.
        </p>
      }
    >
      <RuleRow
        label="A process above 200% CPU for 5 minutes"
        sub="Any one process, for the whole 5 minutes"
        enabled={alerts.hot_process}
        onEnabledChange={(on) => write({ alerts: { hot_process: on } })}
      />
      <RuleRow
        label="Thermal state Serious or worse"
        sub="macOS is slowing the Mac down to cool it"
        enabled={alerts.thermal_serious}
        onEnabledChange={(on) => write({ alerts: { thermal_serious: on } })}
      />
      {rules.map((rule) => (
        <RuleRow
          key={rule.id}
          label={rule.name}
          sub={
            <CustomRuleSub
              rule={rule}
              units={units}
              measured={measured.has(ruleMetric(rule))}
              firedAtMs={lastFired.get(rule.id)}
            />
          }
          enabled={rule.enabled}
          onEnabledChange={(on) => setEnabled(rule.id, on)}
          onEdit={() => onEdit(rule)}
        />
      ))}
    </SettingsPanel>
  );
}

/** The metric ids this Mac has a live series for; changes only with the layout. */
function useMeasuredMetrics(): ReadonlySet<string> {
  const seriesKeys = useSeriesKeys();
  return useMemo(
    () => new Set(availableMetrics(seriesKeys).map((m) => m.metric)),
    [seriesKeys]
  );
}

/** The metric a custom rule watches; empty for a rule without a threshold. */
function ruleMetric(rule: AlertRule): string {
  return "threshold" in rule.when && rule.when.threshold
    ? rule.when.threshold.series.metric
    : "";
}

/**
 * A custom row's sub line: the sentence when the name differs from it,
 * then the last-fired link, "Never fired" or "Not measured on this Mac".
 */
function CustomRuleSub({
  rule,
  units,
  measured,
  firedAtMs,
}: {
  rule: AlertRule;
  units: UnitSettings;
  measured: boolean;
  firedAtMs: number | undefined;
}) {
  const sentence = ruleSummary(rule, units);
  const prefix = sentence === rule.name ? "" : `${sentence} · `;
  if (!measured) return `${prefix}${NOT_MEASURED}`;
  if (firedAtMs === undefined) return `${prefix}${NEVER_FIRED}`;
  return (
    <>
      {prefix}
      <LastFiredLink firedAtMs={firedAtMs} />
    </>
  );
}

/** "Last fired 2 h ago", opening the Timeline on the hour around that alert. */
function LastFiredLink({ firedAtMs }: { firedAtMs: number }) {
  const clock = useHostClock();
  const { apply, pending, range } = useRangeNavigation();
  const navigate = useNavigate();
  const open = async () => {
    const window = windowAroundAlert(firedAtMs);
    const applied = await apply(window);
    // Applying the window already in force is a no-op that still opens it.
    const already =
      range?.endMs === window.absolute.to_ms &&
      range.windowMs === window.absolute.to_ms - window.absolute.from_ms;
    if (applied || already) navigate("/dashboard/timeline");
  };
  return (
    <button
      type="button"
      disabled={pending}
      aria-description="Open in Timeline"
      className="rounded-control text-link underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => void open()}
    >
      {lastFiredText(firedAtMs, clock())}
    </button>
  );
}
