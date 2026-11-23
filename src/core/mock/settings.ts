/**
 * `get_settings` and `update_settings` for the mock transport: applies a
 * patch, rejects what Rust's settings validation rejects (including custom
 * alert rules) with `invalid_settings`, and emits each saved change.
 */
import {
  ALERT_LIMITS,
  ALERT_METRICS,
  type AlertRule,
  type SeriesSelector,
  type Settings,
  type SettingsPatch,
  type SettingsSnapshot,
} from "@core/generated/bindings";
import { validChartRange } from "../chart-range";
import { INTERVALS_MS, menuBarOf, SIZE_LIMITS_MB } from "../settings-patch";
import type { MockCommands } from "./commands";
import type { MockTransport, MockTransportOptions } from "./contracts";
import type { MockEmitters } from "./emitters";
import { defaultSettings, type ScenarioFlags } from "./fixtures";
import { fail, ok } from "./protocol";
export class MockSettings {
  snapshot: SettingsSnapshot;
  onChanged: (before: Settings, after: Settings) => void = () => {};
  constructor(
    private readonly options: MockTransportOptions,
    flags: ScenarioFlags,
    private readonly commands: MockCommands,
    private readonly emitters: MockEmitters
  ) {
    const baseSettings = defaultSettings(flags);
    if (baseSettings.docker)
      baseSettings.docker.enabled =
        (options.scenarios ?? []).some((s) => s.startsWith("docker-")) &&
        !(options.scenarios ?? []).includes("docker-retained");

    if (baseSettings.docker?.enabled && flags.compactPopover)
      baseSettings.docker.show_popover = true;

    const startInterval = options.intervalMs ?? 1000;
    this.snapshot = {
      revision: 1,
      settings: {
        ...baseSettings,
        sampling: { ...baseSettings.sampling, interval_ms: startInterval },
        general: {
          ...baseSettings.general,
          ...(options.chartWindow === undefined
            ? {}
            : { chart_window: options.chartWindow }),
        },
      },
    };
  }
  readonly getSettings: MockTransport["getSettings"] = async () => {
    this.commands.record("get_settings");
    return this.snapshot;
  };
  readonly updateSettings: MockTransport["updateSettings"] = async (patch) => {
    this.commands.record("update_settings", patch);
    if (this.options.settingsNotSaved) {
      return fail({ kind: "settings_not_saved", message: "disk full" });
    }
    const next = withF32Thresholds(applyPatch(this.snapshot.settings, patch));
    const chartWindow = next.general.chart_window;
    if (chartWindow !== undefined && !validChartRange(chartWindow)) {
      return fail({
        kind: "invalid_settings",
        message: `chart window ${chartWindow}`,
      });
    }
    if (
      !(INTERVALS_MS as readonly number[]).includes(next.sampling.interval_ms)
    ) {
      return fail({
        kind: "invalid_settings",
        message: `interval ${next.sampling.interval_ms} ms`,
      });
    }
    if (
      !(SIZE_LIMITS_MB as readonly number[]).includes(
        next.history.size_limit_mb
      )
    ) {
      return fail({
        kind: "invalid_settings",
        message: `size limit ${next.history.size_limit_mb} MB`,
      });
    }
    const rulesProblem = alertRulesProblem(next.alerts?.rules ?? []);
    if (rulesProblem !== null) {
      return fail({ kind: "invalid_settings", message: rulesProblem });
    }
    if (JSON.stringify(next) === JSON.stringify(this.snapshot.settings)) {
      return ok(this.snapshot);
    }
    const previous = this.snapshot.settings;
    this.snapshot = { revision: this.snapshot.revision + 1, settings: next };
    this.onChanged(previous, next);
    this.emitters.settings.emit(this.snapshot);
    return ok(this.snapshot);
  };

  setDocker(next: NonNullable<Settings["docker"]>) {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      settings: { ...this.snapshot.settings, docker: next },
    };
    this.emitters.settings.emit(this.snapshot);
  }
  get methods() {
    return {
      getSettings: this.getSettings,
      updateSettings: this.updateSettings,
    };
  }
}

export function applyPatch(s: Settings, patch: SettingsPatch): Settings {
  const pick = <T extends object>(base: T, p: object | null | undefined) => {
    if (!p) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(p)) {
      if (v !== null && v !== undefined)
        (out as Record<string, unknown>)[k] = v;
    }
    return out;
  };
  const modules = { ...s.modules };
  for (const [id, mp] of Object.entries(patch.modules ?? {})) {
    const cur = modules[id as keyof typeof modules];
    if (cur && mp) modules[id as keyof typeof modules] = pick(cur, mp);
  }
  const mb = patch.menu_bar;
  const base = menuBarOf(s);
  return {
    ...s,
    modules,
    popover: pick(s.popover ?? NO_POPOVER, patch.popover),
    overview: pick(s.overview ?? ALL_OVERVIEW_CARDS, patch.overview),
    menu_bar: {
      bars: pick(base.bars, mb?.bars),
      readouts: pick(base.readouts, mb?.readouts),
      items: pick(base.items, mb?.items),
    },
    sampling: pick(s.sampling, patch.sampling),
    history: pick(s.history, patch.history),
    units: pick(s.units, patch.units),
    general: pick(s.general, patch.general),
    remote_access: pick(
      s.remote_access ?? { enabled: false },
      patch.remote_access
    ),
    cli_access: pick(s.cli_access ?? { enabled: true }, patch.cli_access),
    onboarding: pick(s.onboarding, patch.onboarding),
    alerts: pick(s.alerts ?? NO_ALERTS, patch.alerts),
  };
}
const ALL_OVERVIEW_CARDS = {
  cpu: true,
  gpu: true,
  memory: true,
  power: true,
  network: true,
  disk: true,
  battery: true,
  events: true,
  apps: true,
  folders: true,
  containers: true,
  hosts: true,
};
const NO_ALERTS = {
  hot_process: false,
  thermal_serious: false,
  host_offline: false,
  rules: [],
};

/**
 * `settings` with each custom rule's threshold rounded to f32, as Rust
 * stores it and a later `get_settings` returns it.
 */
function withF32Thresholds(settings: Settings): Settings {
  const rules = settings.alerts?.rules;
  if (settings.alerts === undefined || rules === undefined) return settings;
  const stored = rules.map((rule) => {
    const threshold = rule.when.threshold;
    if (threshold === undefined || threshold.value === null) return rule;
    const value = Math.fround(threshold.value);
    return { ...rule, when: { threshold: { ...threshold, value } } };
  });
  return { ...settings, alerts: { ...settings.alerts, rules: stored } };
}

/**
 * Why Rust's `AlertSettings::validate` would reject `rules`, as the
 * Display text of its `AlertRuleError`, or null when it accepts them.
 */
function alertRulesProblem(rules: readonly AlertRule[]): string | null {
  if (rules.length > ALERT_LIMITS.max_custom) {
    return `at most ${ALERT_LIMITS.max_custom} custom rules`;
  }
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) return "two rules share one id";
    ids.add(rule.id);
    const problem = alertRuleProblem(rule);
    if (problem !== null) return problem;
  }
  return null;
}

/** Why Rust's `AlertRule::validate_custom` would reject `rule`, or null. */
function alertRuleProblem(rule: AlertRule): string | null {
  if ((ALERT_LIMITS.builtin_ids as readonly string[]).includes(rule.id)) {
    return "rule id belongs to a built-in rule";
  }
  const nameChars = [...rule.name].length;
  if (
    rule.name !== rule.name.trim() ||
    nameChars === 0 ||
    nameChars > ALERT_LIMITS.max_name_chars
  ) {
    return `rule name must be 1 to ${ALERT_LIMITS.max_name_chars} characters with no leading or trailing spaces`;
  }
  const threshold = rule.when.threshold;
  if (threshold === undefined) {
    return "a custom rule must be a threshold on one metric";
  }
  return (
    thresholdProblem(threshold.series, threshold.value) ??
    timingProblem(rule.for_secs, rule.cooldown_secs)
  );
}

/**
 * Why Rust rejects a rule watching `series` at `value`: a metric outside
 * `ALERT_METRICS`, labels it does not carry, or a value outside its range.
 */
function thresholdProblem(
  series: SeriesSelector,
  value: number | null
): string | null {
  const metric = ALERT_METRICS.find((m) => m.metric === series.metric);
  if (metric === undefined) {
    return `metric ${JSON.stringify(series.metric)} cannot be alerted on; choose one of the listed metrics`;
  }
  if (!labelsAllowed(series)) {
    return "a rule watches every series of its metric or one series named by a label it carries";
  }
  // The stored value is already f32, and the limits arrive rounded to f32.
  const min = metric.min ?? Number.NaN;
  const max = metric.max ?? Number.NaN;
  if (value === null || !(value >= min && value <= max)) {
    return "threshold is outside the range this metric accepts";
  }
  return null;
}

/** No labels, or one pair whose key the metric carries (`ALERT_LIMITS`). */
function labelsAllowed(series: SeriesSelector): boolean {
  const keysByMetric: Readonly<Record<string, readonly string[]>> =
    ALERT_LIMITS.label_keys;
  const carried = keysByMetric[series.metric] ?? [];
  if (series.labels.length > 1) return false;
  return series.labels.every(([key]) => carried.includes(key));
}

/** Why Rust rejects a rule's hold time or cooldown, or null. */
function timingProblem(forSecs: number, cooldownSecs: number): string | null {
  if (forSecs > ALERT_LIMITS.max_for_secs) {
    return "duration must be at most 1 hour";
  }
  if (
    cooldownSecs < ALERT_LIMITS.min_cooldown_secs ||
    cooldownSecs > ALERT_LIMITS.max_cooldown_secs
  ) {
    return "cooldown must be between 1 minute and 24 hours";
  }
  return null;
}

const NO_POPOVER = {
  cpu: "expanded",
  memory: "expanded",
  gpu: "expanded",
  power: "expanded",
  network: "expanded",
  battery: "expanded",
  containers: "expanded",
} as const;
