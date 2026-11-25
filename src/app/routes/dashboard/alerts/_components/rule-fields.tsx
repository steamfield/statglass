/**
 * The rule dialog's fields: what a rule watches and when it fires
 * (`ConditionPanel`), and its name and cooldown (`NotificationPanel`). They
 * render a `RuleForm` and report each edit as the next form.
 */
import {
  availableMetrics,
  COOLDOWN_CHOICES_SECS,
  FOR_CHOICES_SECS,
  type SeriesChoice,
  seriesChoices,
  seriesName,
  thresholdToDisplay,
} from "@core/alerts";
import type { UnitSettings } from "@core/generated/types";
import { sk } from "@core/series-key";
import { type ReactNode, useId } from "react";
import { SegmentedControl } from "~/components/segmented-control";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useSeriesKeys } from "../_hooks/use-series-keys";
import {
  durationText,
  type RuleForm,
  withChange,
  withMetric,
} from "../_lib/rule-form";
import { NowLine } from "./now-line";

/** Props of the field panels. */
export interface RuleFieldsProps {
  form: RuleForm;
  units: UnitSettings;
  /** The form after one edit. */
  onChange: (form: RuleForm) => void;
}

const TEXT_INPUT =
  "h-8 rounded-control border border-input bg-background px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring";

const COMPARISONS = [
  { value: "gt", label: "above" },
  { value: "lt", label: "below" },
] as const;

/** Metric, series, comparison, threshold and duration, with the value now. */
export function ConditionPanel({
  form,
  units,
  onChange,
}: RuleFieldsProps): ReactNode {
  const id = useId();
  const change = (c: Parameters<typeof withChange>[1]) =>
    onChange(withChange(form, c, units));
  const direction = form.op === "gt" || form.op === "ge" ? "gt" : "lt";
  const now = (
    <NowLine
      metric={form.metric}
      labels={form.labels}
      op={direction}
      units={units}
    />
  );
  return (
    <SettingsPanel title="Condition" after={now}>
      <MetricRows form={form} units={units} onChange={onChange} />
      <SettingsRow label="When it is">
        <SegmentedControl
          ariaLabel="When it is"
          options={COMPARISONS}
          value={direction}
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
          <span className="text-muted-foreground text-small">
            {thresholdToDisplay(form.metric, 0, units).unit}
          </span>
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

/** The rule's name and how long it waits before alerting again. */
export function NotificationPanel({
  form,
  onChange,
}: Omit<RuleFieldsProps, "units">): ReactNode {
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

/**
 * The live series of the form's metric, plus the stored series when it is
 * no longer live (a rule on fan 2 with only fans 0 and 1 present), so the
 * select still shows what the rule watches.
 */
function watchChoices(
  form: RuleForm,
  seriesKeys: readonly string[]
): SeriesChoice[] {
  const live = seriesChoices(form.metric, seriesKeys);
  const stored = sk(form.metric, form.labels);
  if (live.some((c) => sk(form.metric, c.labels) === stored)) return live;
  const label = seriesName(form.metric, form.labels) ?? stored;
  return [...live, { label, labels: form.labels }];
}

/** The metric select and, for a metric with several series, the series select. */
function MetricRows({ form, units, onChange }: RuleFieldsProps) {
  const id = useId();
  const seriesKeys = useSeriesKeys();
  const available = availableMetrics(seriesKeys);
  // A stored rule on a metric this Mac lacks still shows its metric.
  const metrics = available.some((m) => m.metric === form.metric)
    ? available
    : [...available, ...availableMetrics([form.metric])];
  const series = watchChoices(form, seriesKeys);
  const seriesKey = (c: SeriesChoice) => sk(form.metric, c.labels);
  const chooseMetric = (metric: string) => {
    const next = metrics.find((m) => m.metric === metric);
    if (next) onChange(withMetric(form, next, units));
  };
  const chooseSeries = (key: string) => {
    const next = series.find((c) => seriesKey(c) === key);
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
              value: seriesKey(c),
              label: c.label,
            }))}
            onChange={chooseSeries}
          />
        </SettingsRow>
      )}
    </>
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
