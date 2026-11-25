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
  type Event,
  type RemoteHostRecord,
  type UnitSettings,
} from "@core/generated/types";
import { settingsErrorText } from "@core/settings-patch";
import { MINUTE_MS } from "@core/time-grid";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { SettingsPanel } from "~/components/settings-row";
import { useNow } from "~/hooks/use-now";
import { useOpenInTimeline } from "~/hooks/use-open-in-timeline";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { useSettings, useUpdateSettings } from "~/stores/settings-store";
import { useRecentAlerts } from "../_hooks/use-recent-alerts";
import { useSeriesKeys } from "../_hooks/use-series-keys";
import { lastFiredText } from "../_lib/last-fired";
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

/** The built-in rules this panel switches, in row order. */
const BUILTINS = [
  {
    setting: "hot_process",
    id: ALERT_LIMITS.hot_process_id,
    label: "A process above 200% CPU for 5 minutes",
    description: "Any one process, for the whole 5 minutes",
  },
  {
    setting: "thermal_serious",
    id: ALERT_LIMITS.thermal_serious_id,
    label: "Thermal state Serious or worse",
    description: "macOS is slowing the Mac down to cool it",
  },
  {
    setting: "host_offline",
    id: ALERT_LIMITS.host_offline_id,
    label: "A saved host is offline for 5 minutes",
    description: "Checked while this Mac is awake and online",
  },
] as const;

const NOT_MEASURED = "Not measured on this Mac";
const NEVER_FIRED = "Never fired";

/**
 * A rule's newest alert in the last 7 days, "never" when it has none, or
 * "unknown" when the alerts could not be read.
 */
type LastAlert = Event | "never" | "unknown";

/**
 * A `SettingsPanel` titled "Rules". The built-in rows come first ("A
 * process above 200% CPU for 5 minutes", "Thermal state Serious or worse",
 * and "A saved host is offline for 5 minutes" while a remote host is saved)
 * and write `{ alerts: { hot_process } }`, `{ alerts: { thermal_serious } }`
 * or `{ alerts: { host_offline } }`. Each custom row's label is the rule name; its sub
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
  const lastAlert = useLastAlerts();
  const hostSaved = useRemoteHosts(anyHost).data ?? false;
  if (alerts === null || units === null) return null;
  // The host rule has nothing to watch until a remote host is saved.
  const builtins = BUILTINS.filter(
    (b) => b.setting !== "host_offline" || hostSaved
  );
  // Absent from a settings file written before custom rules: none.
  const rules = alerts.rules ?? [];
  const setEnabled = (id: string, enabled: boolean) =>
    write({
      rules: rules.map((r) => (r.id === id ? { ...r, enabled } : r)),
    });
  return (
    <SettingsPanel title="Rules" after={<SwitchingNote />}>
      {builtins.map((b) => (
        <RuleRow
          key={b.id}
          label={b.label}
          sub={<RuleSub prefix={b.description} lastAlert={lastAlert(b.id)} />}
          enabled={alerts[b.setting] ?? false}
          disabled={pending}
          onEnabledChange={(on) => write({ [b.setting]: on })}
        />
      ))}
      {rules.map((rule) => (
        <CustomRuleRow
          key={rule.id}
          rule={rule}
          units={units}
          measured={measured}
          lastAlert={lastAlert(rule.id)}
          disabled={pending}
          onEnabledChange={(on) => setEnabled(rule.id, on)}
          onEdit={() => onEdit(rule)}
        />
      ))}
    </SettingsPanel>
  );
}

export function CustomRuleRow({
  rule,
  units,
  measured,
  lastAlert,
  notMeasured,
  disabled,
  onEnabledChange,
  onEdit,
}: {
  rule: AlertRule;
  units: UnitSettings;
  measured: ReadonlySet<string>;
  lastAlert: LastAlert;
  notMeasured?: string;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onEdit: () => void;
}) {
  return (
    <RuleRow
      label={rule.name}
      sub={
        <RuleSub
          prefix={sentenceUnlessName(rule, units)}
          measured={measured.has(ruleMetric(rule))}
          notMeasured={notMeasured}
          lastAlert={lastAlert}
        />
      }
      enabled={rule.enabled}
      disabled={disabled}
      onEnabledChange={onEnabledChange}
      onEdit={onEdit}
    />
  );
}

/** Whether any remote host is saved; selected so a status poll re-renders nothing. */
function anyHost(hosts: RemoteHostRecord[]): boolean {
  return hosts.length > 0;
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

/** Each rule's `LastAlert` (`lastFiredByRule`), looked up by rule id. */
export function useLastAlerts(): (ruleId: string) => LastAlert {
  const { alerts, isError } = useRecentAlerts();
  const newest = useMemo(() => lastFiredByRule(alerts), [alerts]);
  return (ruleId) => (isError ? "unknown" : (newest.get(ruleId) ?? "never"));
}

/** The metric ids this host has a live series for; changes only with the layout. */
export function useMeasuredMetrics(): ReadonlySet<string> {
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
 * last-fired line, "Never fired", or "Not measured on this Mac". Nothing
 * follows the prefix when the alerts could not be read.
 */
function RuleSub({
  prefix,
  measured = true,
  notMeasured = NOT_MEASURED,
  lastAlert,
}: {
  prefix: string | null;
  measured?: boolean;
  notMeasured?: string | undefined;
  lastAlert: LastAlert;
}) {
  const lead = prefix === null ? "" : `${prefix} · `;
  if (!measured) return `${lead}${notMeasured}`;
  if (lastAlert === "unknown") return prefix;
  if (lastAlert === "never") return `${lead}${NEVER_FIRED}`;
  return (
    <>
      {lead}
      <LastFired alert={lastAlert} />
    </>
  );
}

/**
 * "Last fired 2 h ago", opening the Timeline on the range the Recent list
 * opens for that alert; plain text when none of its time is kept. Its clock
 * moves once a minute, re-rendering only this line.
 */
function LastFired({ alert }: { alert: Event }) {
  const nowMs = useNow(MINUTE_MS);
  const { rangeFor, open, pending } = useOpenInTimeline();
  const text = lastFiredText(alert.ts_ms, nowMs);
  const range = rangeFor(alert);
  if (range === null) return text;
  return (
    <button
      type="button"
      disabled={pending}
      aria-description="Open in Timeline"
      className="rounded-control text-link underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => void open(range)}
    >
      {text}
    </button>
  );
}
