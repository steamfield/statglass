/**
 * The Alerts page's Rules panel: the built-in rules, then the user's
 * threshold rules, one switch row each.
 */
import { availableMetrics, lastFiredByRule, ruleSummary } from "@core/alerts";
import {
  ALERT_LIMITS,
  type AlertRule,
  type AlertSettings,
  type AlertsPatch,
  type UnitSettings,
} from "@core/generated/bindings";
import { settingsErrorText } from "@core/settings-patch";
import { MINUTE_MS } from "@core/time-grid";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { SettingsPanel } from "~/components/settings-row";
import { useNow } from "~/hooks/use-now";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useSettings, useUpdateSettings } from "~/stores/settings-store";
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

// Rust's `AlertRule::BUILTIN_IDS` order: hot process, thermal serious, host offline.
const [HOT_PROCESS_ID, THERMAL_SERIOUS_ID] = ALERT_LIMITS.builtin_ids;

/** The built-in rules this panel switches, in row order. */
const BUILTINS = [
  {
    setting: "hot_process",
    id: HOT_PROCESS_ID,
    label: "A process above 200% CPU for 5 minutes",
    description: "Any one process, for the whole 5 minutes",
  },
  {
    setting: "thermal_serious",
    id: THERMAL_SERIOUS_ID,
    label: "Thermal state Serious or worse",
    description: "macOS is slowing the Mac down to cool it",
  },
] as const;

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
  const { pending, write } = useAlertsWrite();
  const measured = useMeasuredMetrics();
  const { alerts: recent } = useRecentAlerts();
  const lastFired = useMemo(() => lastFiredByRule(recent), [recent]);
  if (alerts === null || units === null) return null;
  // Absent from a settings file written before custom rules: none.
  const rules = alerts.rules ?? [];
  const setEnabled = (id: string, enabled: boolean) =>
    write({
      rules: rules.map((r) => (r.id === id ? { ...r, enabled } : r)),
    });
  return (
    <SettingsPanel title="Rules" after={<SwitchingNote />}>
      {BUILTINS.map((b) => (
        <RuleRow
          key={b.id}
          label={b.label}
          sub={
            <RuleSub prefix={b.description} firedAtMs={lastFired.get(b.id)} />
          }
          enabled={alerts[b.setting]}
          disabled={pending}
          onEnabledChange={(on) => write({ [b.setting]: on })}
        />
      ))}
      {rules.map((rule) => (
        <RuleRow
          key={rule.id}
          label={rule.name}
          sub={
            <RuleSub
              prefix={sentenceUnlessName(rule, units)}
              measured={measured.has(ruleMetric(rule))}
              firedAtMs={lastFired.get(rule.id)}
            />
          }
          enabled={rule.enabled}
          disabled={pending}
          onEnabledChange={(on) => setEnabled(rule.id, on)}
          onEdit={() => onEdit(rule)}
        />
      ))}
    </SettingsPanel>
  );
}

/** The panel's one line under the rows. */
function SwitchingNote() {
  return (
    <p className="m-0 text-label text-muted-foreground">
      Switching a rule on sends an “Alerts are on” notification, so macOS can
      ask for permission now.
    </p>
  );
}

/**
 * Sends one alerts patch at a time. `pending` is true until it answers, so
 * the rows can lock: each patch carries the rules list from the last
 * render, and two in flight would undo each other. A failure says why in a
 * toast, as the Settings page's writes do.
 */
function useAlertsWrite() {
  const update = useUpdateSettings();
  const [pending, setPending] = useState(false);
  const write = useCallback(
    async (alerts: AlertsPatch) => {
      const fail = (error: unknown) => {
        console.error("[alerts] update_settings failed", { alerts, error });
        toast.error(settingsErrorText(error));
      };
      setPending(true);
      try {
        const result = await update({ alerts });
        if (result.status === "error") fail(result.error);
      } catch (error) {
        fail(error);
      } finally {
        setPending(false);
      }
    },
    [update]
  );
  return { pending, write: (alerts: AlertsPatch) => void write(alerts) };
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

/** The rule's sentence, or null when the rule is named by it. */
function sentenceUnlessName(
  rule: AlertRule,
  units: UnitSettings
): string | null {
  const sentence = ruleSummary(rule, units);
  return sentence === rule.name ? null : sentence;
}

/**
 * A row's sub line: `prefix` (a description or sentence), then the
 * last-fired link, "Never fired", or "Not measured on this Mac".
 */
function RuleSub({
  prefix,
  measured = true,
  firedAtMs,
}: {
  prefix: string | null;
  measured?: boolean;
  firedAtMs: number | undefined;
}) {
  const lead = prefix === null ? "" : `${prefix} · `;
  if (!measured) return `${lead}${NOT_MEASURED}`;
  if (firedAtMs === undefined) return `${lead}${NEVER_FIRED}`;
  return (
    <>
      {lead}
      <LastFiredLink firedAtMs={firedAtMs} />
    </>
  );
}

/**
 * "Last fired 2 h ago", opening the Timeline on the hour around that alert.
 * Its clock moves once a minute, re-rendering only this link.
 */
function LastFiredLink({ firedAtMs }: { firedAtMs: number }) {
  const nowMs = useNow(MINUTE_MS);
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
      {lastFiredText(firedAtMs, nowMs)}
    </button>
  );
}
