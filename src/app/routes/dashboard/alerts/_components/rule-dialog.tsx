/**
 * The rule editor: a dialog over one custom rule's form (`_lib/rule-form`),
 * saved as one settings patch.
 */
import { formatAlertValue } from "@core/alert-values";
import {
  availableMetrics,
  COOLDOWN_CHOICES_SECS,
  FOR_CHOICES_SECS,
  seriesChoices,
  thresholdToDisplay,
} from "@core/alerts";
import { displayUnits } from "@core/format";
import type { AlertRule, UnitSettings } from "@core/generated/bindings";
import { sk } from "@core/series-key";
import { settingsErrorText } from "@core/settings-patch";
import { type ReactNode, useId, useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { SegmentedControl } from "~/components/segmented-control";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useHost } from "~/stores/host-store";
import { held, keysOf } from "~/stores/live-selectors";
import { useSettings, useUpdateSettings } from "~/stores/settings-store";
import { useSeriesKeys } from "../_hooks/use-series-keys";
import {
  durationText,
  formFromRule,
  formProblem,
  type RuleForm,
  ruleFromForm,
  withChange,
  withMetric,
} from "../_lib/rule-form";

/** The rule the dialog edits, and whether Save appends it or replaces it. */
export interface RuleDraft {
  rule: AlertRule;
  isNew: boolean;
}

/** Props of `RuleDialog`. */
export interface RuleDialogProps {
  /** The rule to edit; null keeps the dialog closed. */
  draft: RuleDraft | null;
  /** Close without anything further: after Save, Delete, Cancel or Escape. */
  onClose: () => void;
}

type FormChange = (form: RuleForm) => void;

const NO_RULES: AlertRule[] = [];

const TEXT_INPUT =
  "h-8 rounded-control border border-input bg-background px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring";

const COMPARISONS = [
  { value: "gt", label: "above" },
  { value: "lt", label: "below" },
] as const;

/**
 * The "New rule" / "Edit rule" dialog. Fields labelled "Name", "Metric",
 * "Watch" (only for a labelled metric: "Any", then series names), "When it
 * is" (above, below), "Threshold" with its display unit, "For" and "Then
 * wait"; a "Now" line with the watched series' current value, the only part
 * that renders on a live tick; `formProblem` text inline with Save
 * disabled. Save sends `{ alerts: { rules } }` with the rule appended (new)
 * or replaced (edit) through `updateSettings` and closes; a rejected save
 * shows its message inline and keeps the form. Delete (existing rules only)
 * removes the rule and closes. Cancel and Escape write nothing.
 */
export function RuleDialog({ draft, onClose }: RuleDialogProps): ReactNode {
  const units = useSettings((s) => s.units);
  if (draft === null || units === null) return null;
  // Units are fixed for one editing session, so the typed threshold keeps its unit.
  return (
    <RuleEditor
      key={draft.rule.id}
      draft={draft}
      units={units}
      onClose={onClose}
    />
  );
}

/** The form a draft opens with; a new rule is named after its sentence. */
function initialForm(draft: RuleDraft, units: UnitSettings): RuleForm {
  const form = formFromRule(draft.rule, units);
  return draft.isNew
    ? withChange({ ...form, autoName: true }, {}, units)
    : form;
}

/** Writes the rules list once; closes on success, keeps the reason on failure. */
function useRulesWrite(onClose: () => void) {
  const update = useUpdateSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = async (rules: AlertRule[]) => {
    setSaving(true);
    setError(null);
    try {
      const result = await update({ alerts: { rules } });
      if (result.status === "ok") return onClose();
      setError(settingsErrorText(result.error));
    } catch (err) {
      console.error("[alerts] update_settings failed", { err });
      setError(settingsErrorText(err));
    }
    setSaving(false);
  };
  return { saving, error, write };
}

/** The open dialog for one draft, holding its form until it closes. */
function RuleEditor({
  draft,
  units,
  onClose,
}: {
  draft: RuleDraft;
  units: UnitSettings;
  onClose: () => void;
}) {
  const rules = useSettings((s) => s.alerts?.rules ?? NO_RULES) ?? NO_RULES;
  const [form, setForm] = useState(() => initialForm(draft, units));
  const { saving, error, write } = useRulesWrite(onClose);
  const problem = formProblem(form, units);
  const save = () => {
    const rule = ruleFromForm(form, units);
    void write(
      draft.isNew
        ? [...rules, rule]
        : rules.map((r) => (r.id === rule.id ? rule : r))
    );
  };
  const remove = () => void write(rules.filter((r) => r.id !== form.id));
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={!saving}
        className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      >
        <header className="border-border-subtle border-b px-5 py-4 pr-12">
          <DialogTitle>{draft.isNew ? "New rule" : "Edit rule"}</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
          <fieldset disabled={saving} className="flex min-w-0 flex-col gap-5">
            <ConditionPanel form={form} units={units} onChange={setForm} />
            <NotificationPanel form={form} onChange={setForm} />
          </fieldset>
          {(problem ?? error) && (
            <InlineMessage tone="error">{problem ?? error}</InlineMessage>
          )}
        </div>
        <footer className="flex shrink-0 gap-2 border-border-subtle border-t px-5 py-3">
          {!draft.isNew && (
            <Button variant="outline" disabled={saving} onClick={remove}>
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || problem !== null} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** What the rule watches and when it fires, with the watched value now. */
function ConditionPanel({
  form,
  units,
  onChange,
}: {
  form: RuleForm;
  units: UnitSettings;
  onChange: FormChange;
}) {
  const id = useId();
  const change = (c: Parameters<typeof withChange>[1]) =>
    onChange(withChange(form, c, units));
  const unit = thresholdToDisplay(form.metric, 0, units).unit;
  return (
    <SettingsPanel
      title="Condition"
      after={<NowLine form={form} units={units} />}
    >
      <MetricRows form={form} units={units} onChange={onChange} />
      <SettingsRow label="When it is">
        <SegmentedControl
          ariaLabel="When it is"
          options={COMPARISONS}
          value={form.op}
          onChange={(op) => change({ op })}
        />
      </SettingsRow>
      <SettingsRow label="Threshold" htmlFor={`${id}-threshold`}>
        <div className="flex items-center gap-2">
          <input
            id={`${id}-threshold`}
            inputMode="decimal"
            className={`${TEXT_INPUT} figures w-24 text-right`}
            value={form.shown}
            onChange={(e) => change({ shown: e.target.value })}
          />
          <span className="text-muted-foreground text-small">{unit}</span>
        </div>
      </SettingsRow>
      <SettingsRow label="For" htmlFor={`${id}-for`}>
        <DurationSelect
          id={`${id}-for`}
          choices={FOR_CHOICES_SECS}
          value={form.forSecs}
          onChange={(forSecs) => change({ forSecs })}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}

/** The metric select and, for a metric with several series, the series select. */
function MetricRows({
  form,
  units,
  onChange,
}: {
  form: RuleForm;
  units: UnitSettings;
  onChange: FormChange;
}) {
  const id = useId();
  const seriesKeys = useSeriesKeys();
  const available = availableMetrics(seriesKeys);
  // A stored rule on a metric this Mac lacks still shows its metric.
  const metrics = available.some((m) => m.metric === form.metric)
    ? available
    : [...available, ...availableMetrics([form.metric])];
  const series = seriesChoices(form.metric, seriesKeys);
  const chooseMetric = (metric: string) => {
    const next = metrics.find((m) => m.metric === metric);
    if (next) onChange(withMetric(form, next, units));
  };
  const chooseSeries = (key: string) => {
    const next = series.find((c) => sk(form.metric, c.labels) === key);
    if (next) onChange(withChange(form, { labels: next.labels }, units));
  };
  return (
    <>
      <SettingsRow label="Metric" htmlFor={`${id}-metric`}>
        <Choice
          id={`${id}-metric`}
          value={form.metric}
          options={metrics.map((m) => ({ value: m.metric, label: m.label }))}
          onChange={chooseMetric}
        />
      </SettingsRow>
      {series.length > 1 && (
        <SettingsRow label="Watch" htmlFor={`${id}-watch`}>
          <Choice
            id={`${id}-watch`}
            value={sk(form.metric, form.labels)}
            options={series.map((c) => ({
              value: sk(form.metric, c.labels),
              label: c.label,
            }))}
            onChange={chooseSeries}
          />
        </SettingsRow>
      )}
    </>
  );
}

/** The rule's name and how long it waits before alerting again. */
function NotificationPanel({
  form,
  onChange,
}: {
  form: RuleForm;
  onChange: FormChange;
}) {
  const id = useId();
  return (
    <SettingsPanel title="Notification">
      <SettingsRow label="Name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={`${TEXT_INPUT} w-full max-w-72`}
          value={form.name}
          onChange={(e) =>
            onChange({ ...form, name: e.target.value, autoName: false })
          }
        />
      </SettingsRow>
      <SettingsRow label="Then wait" htmlFor={`${id}-wait`}>
        <DurationSelect
          id={`${id}-wait`}
          choices={COOLDOWN_CHOICES_SECS}
          value={form.cooldownSecs}
          onChange={(cooldownSecs) => onChange({ ...form, cooldownSecs })}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}

/** A select of durations; a stored value outside `choices` is offered too. */
function DurationSelect({
  id,
  choices,
  value,
  onChange,
}: {
  id: string;
  choices: readonly number[];
  value: number;
  onChange: (secs: number) => void;
}) {
  const offered = choices.includes(value)
    ? choices
    : [...choices, value].sort((a, b) => a - b);
  return (
    <Choice
      id={id}
      value={String(value)}
      options={offered.map((secs) => ({
        value: String(secs),
        label: durationText(secs),
      }))}
      onChange={(secs) => onChange(Number(secs))}
    />
  );
}

/** A small select whose trigger a row label names through `id`. */
function Choice({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} size="sm" className="px-2 text-small">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * "Now 84%": the watched series' current value, or for "Any" the series
 * nearest the threshold's side (highest for above, lowest for below). The
 * only part of the dialog that subscribes to the live store.
 */
function NowLine({ form, units }: { form: RuleForm; units: UnitSettings }) {
  const value = useHost((s) => {
    if (Object.keys(form.labels).length > 0) {
      return held(s, sk(form.metric, form.labels));
    }
    const values = keysOf(s, form.metric)
      .map((key) => held(s, key))
      .filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    return form.op === "gt" ? Math.max(...values) : Math.min(...values);
  });
  return (
    <p className="figures m-0 text-muted-foreground text-small">
      Now {formatAlertValue(form.metric, value, displayUnits(units))}
    </p>
  );
}
