import { availableMetrics, newRule, ruleSummary } from "@core/alerts";
import {
  ALERT_LIMITS,
  ALERT_METRICS,
  type AlertMetric,
  type AlertRule,
  type UnitSettings,
} from "@core/generated/types";
import {
  formForMetric,
  formFromRule,
  formProblem,
  type RuleForm,
  ruleFromForm,
  withMetric,
} from "./rule-form";

const ID = "c0ffee00-0000-4000-8000-0000000000b1";
const METRIC_UNITS: UnitSettings = {
  temperature: "celsius",
  network: "bytes_per_sec",
  memory: "decimal",
};
const DISPLAY_UNITS: UnitSettings = {
  temperature: "fahrenheit",
  network: "bytes_per_sec",
  memory: "binary",
};

const UNIT_CHOICES = [
  ["°C and decimal bytes", METRIC_UNITS],
  ["°F and binary bytes", DISPLAY_UNITS],
] as const;

function metric(id: string): AlertMetric {
  const found = availableMetrics([id])[0];
  if (!found) throw new Error(`${id} is not an alertable metric`);
  return found;
}

/** A stored rule on `id` with a typed name and the given changes. */
function rule(
  id: string,
  change: { value?: number; labels?: [string, string][] } = {}
): AlertRule {
  const base = newRule(metric(id), ID);
  if (!("threshold" in base.when) || !base.when.threshold) {
    throw new Error("newRule made a rule without a threshold");
  }
  const { series, op, value } = base.when.threshold;
  return {
    ...base,
    name: "Watch this",
    cooldown_secs: 900,
    enabled: false,
    when: {
      threshold: {
        series: {
          metric: series.metric,
          labels: change.labels ?? series.labels,
        },
        op,
        value: change.value ?? value,
      },
    },
  };
}

function thresholdOf(r: AlertRule) {
  if (!("threshold" in r.when) || !r.when.threshold) {
    throw new Error(`rule ${r.id} has no threshold`);
  }
  return r.when.threshold;
}

describe("rule form round trip", () => {
  it.each([
    ["one volume", rule("disk.free", { value: 50e9 })],
    ["one fan", rule("fan.rpm", { labels: [["fan", "1"]] })],
    ["every series of a labelled metric", rule("fan.rpm", { labels: [] })],
  ])("stores %s rule as it read it", (_kind, stored) => {
    for (const units of [METRIC_UNITS, DISPLAY_UNITS]) {
      expect(ruleFromForm(formFromRule(stored, units), units)).toEqual(stored);
    }
  });

  it.each(
    ALERT_METRICS.flatMap((m) =>
      UNIT_CHOICES.map(([name, units]) => [m.metric, name, units] as const)
    )
  )(
    "sends an untouched %s threshold back exactly in %s",
    (id, _name, units) => {
      // Fractional values in every unit, which the cut display text loses.
      for (const value of [Math.fround(4e9 / 3), Math.fround(71.123_456)]) {
        const entry = ALERT_METRICS.find((m) => m.metric === id);
        if (!entry || entry.min === null || entry.max === null) {
          throw new Error(`${id} has no range`);
        }
        const inRange = Math.min(Math.max(value, entry.min), entry.max);
        const stored = rule(id, { value: inRange });
        const back = ruleFromForm(formFromRule(stored, units), units);
        expect(Object.is(thresholdOf(back).value, inRange)).toBe(true);
      }
    }
  );

  it("sends the converted value once the threshold is edited", () => {
    const stored = rule("mem.swap_used", { value: 4e9 });
    const form = formFromRule(stored, DISPLAY_UNITS);
    expect(form.shown).toBe("3.72529");
    const typed = ruleFromForm({ ...form, shown: "5" }, DISPLAY_UNITS);
    expect(thresholdOf(typed).value).toBe(5 * 2 ** 30);
    const comma = ruleFromForm({ ...form, shown: "3,5" }, DISPLAY_UNITS);
    expect(thresholdOf(comma).value).toBe(3.5 * 2 ** 30);
  });

  it("reads the shown text as the parser does before calling it edited", () => {
    const stored = rule("mem.swap_used", { value: 4e9 });
    const form = formFromRule(stored, DISPLAY_UNITS);
    for (const shown of [" 3.72529 ", "3,72529"]) {
      const back = ruleFromForm({ ...form, shown }, DISPLAY_UNITS);
      expect(thresholdOf(back).value).toBe(4e9);
    }
  });

  it("converts the text again after a metric change", () => {
    const swap = formFromRule(rule("mem.swap_used"), DISPLAY_UNITS);
    const disk = withMetric(swap, metric("disk.free"), DISPLAY_UNITS);
    expect(thresholdOf(ruleFromForm(disk, DISPLAY_UNITS)).value).toBe(20e9);
    const typed = ruleFromForm({ ...disk, shown: "30" }, DISPLAY_UNITS);
    expect(thresholdOf(typed).value).toBe(30e9);
  });

  it("shows the threshold in the display unit", () => {
    expect(formFromRule(rule("thermal.hottest"), DISPLAY_UNITS).shown).toBe(
      "203"
    );
    expect(formFromRule(rule("mem.swap_used"), DISPLAY_UNITS).shown).toBe(
      "3.72529"
    );
  });

  it("follows the sentence only for a rule named after it", () => {
    const named = rule("mem.pressure");
    const sentence = { ...named, name: ruleSummary(named, METRIC_UNITS) };
    expect(formFromRule(named, METRIC_UNITS).autoName).toBe(false);
    expect(formFromRule(sentence, METRIC_UNITS).autoName).toBe(true);
  });

  it("trims the name it stores", () => {
    const form = formFromRule(rule("mem.pressure"), METRIC_UNITS);
    expect(
      ruleFromForm({ ...form, name: "  Pressure  " }, METRIC_UNITS).name
    ).toBe("Pressure");
  });
});

describe("formForMetric", () => {
  it("starts a disk rule on the boot volume with the metric's defaults", () => {
    const form = formForMetric(metric("disk.free"), ID, METRIC_UNITS);
    expect(form).toEqual({
      id: ID,
      name: "Free disk space (/) below 20 GB",
      autoName: true,
      metric: "disk.free",
      labels: { vol: "/" },
      op: "lt",
      shown: "20",
      storedValue: 20e9,
      storedShown: "20",
      forSecs: 0,
      cooldownSecs: 1800,
      enabled: true,
    } satisfies RuleForm);
  });

  it.each([
    {
      metric: "mem.psi",
      labels: { stall: "some" },
      name: "Memory stall above 10% for 2 min",
      shown: "10",
      storedValue: 10,
      forSecs: 120,
    },
    {
      metric: "cpu.loadavg",
      labels: { window: "5" },
      name: "Load average (5 min) above 4 for 5 min",
      shown: "4",
      storedValue: 4,
      forSecs: 300,
    },
  ])("starts $metric with its Rust defaults", (expected) => {
    const form = formForMetric(metric(expected.metric), ID, METRIC_UNITS);
    expect(form).toEqual({
      ...expected,
      id: ID,
      autoName: true,
      op: "gt",
      storedShown: expected.shown,
      cooldownSecs: 1800,
      enabled: true,
    } satisfies RuleForm);
  });
});

describe("withMetric", () => {
  it("replaces an automatic name with the new sentence", () => {
    const cpu = formForMetric(metric("cpu.total"), ID, METRIC_UNITS);
    const next = withMetric(
      { ...cpu, cooldownSecs: 3600 },
      metric("mem.pressure"),
      METRIC_UNITS
    );
    expect(next).toEqual({
      id: ID,
      name: "Memory pressure above 80% for 2 min",
      autoName: true,
      metric: "mem.pressure",
      labels: {},
      op: "gt",
      shown: "80",
      storedValue: 80,
      storedShown: "80",
      forSecs: 120,
      cooldownSecs: 3600,
      enabled: true,
    } satisfies RuleForm);
  });

  it("keeps a typed name", () => {
    const cpu = formForMetric(metric("cpu.total"), ID, METRIC_UNITS);
    const next = withMetric(
      { ...cpu, name: "Busy Mac", autoName: false },
      metric("battery.charge"),
      METRIC_UNITS
    );
    expect(next.name).toBe("Busy Mac");
    expect(next.autoName).toBe(false);
    expect(next.op).toBe("lt");
    expect(next.shown).toBe("20");
  });
});

describe("formProblem", () => {
  it.each([
    ["mem.psi", "0.01", "Between 0.01 and 100%"],
    ["cpu.loadavg", "0.1", "Between 0.1 and 1,000"],
  ])("shows the real minimum for %s and accepts it", (id, min, problem) => {
    const form = formForMetric(metric(id), ID, METRIC_UNITS);
    expect(formProblem({ ...form, shown: "0" }, METRIC_UNITS)).toBe(problem);
    expect(formProblem({ ...form, shown: min }, METRIC_UNITS)).toBeNull();
  });

  const cpu: RuleForm = {
    id: ID,
    name: "CPU usage above 90% for 5 min",
    autoName: true,
    metric: "cpu.total",
    labels: {},
    op: "gt",
    shown: "90",
    storedValue: 90,
    storedShown: "90",
    forSecs: 300,
    cooldownSecs: 1800,
    enabled: true,
  };
  const hottest: RuleForm = {
    ...cpu,
    name: "Hot Mac",
    autoName: false,
    metric: "thermal.hottest",
    shown: "203",
    forSecs: 120,
  };
  const longName = "x".repeat(ALERT_LIMITS.max_name_chars + 1);

  it.each([
    ["a valid rule", cpu, METRIC_UNITS, null],
    [
      "an empty threshold",
      { ...cpu, shown: "" },
      METRIC_UNITS,
      "Enter a number",
    ],
    [
      "a word for a threshold",
      { ...cpu, shown: "lots" },
      METRIC_UNITS,
      "Enter a number",
    ],
    [
      "a percent over the range",
      { ...cpu, shown: "150" },
      METRIC_UNITS,
      "Between 1 and 100%",
    ],
    [
      "a percent under the range",
      { ...cpu, shown: "0" },
      METRIC_UNITS,
      "Between 1 and 100%",
    ],
    [
      "a temperature over the °F range",
      { ...hottest, shown: "300" },
      DISPLAY_UNITS,
      "Between 86 and 266 °F",
    ],
    ["a temperature inside the °F range", hottest, DISPLAY_UNITS, null],
    [
      "a blank name",
      { ...cpu, name: "   ", autoName: false },
      METRIC_UNITS,
      "Give the rule a name",
    ],
    [
      "a name over the limit",
      { ...cpu, name: longName, autoName: false },
      METRIC_UNITS,
      `Use at most ${ALERT_LIMITS.max_name_chars} characters`,
    ],
    [
      "a bad threshold and a blank name",
      { ...cpu, shown: "", name: "", autoName: false },
      METRIC_UNITS,
      "Enter a number",
    ],
  ])("reports %s", (_case, form, units, problem) => {
    expect(formProblem(form, units)).toBe(problem);
  });
});
