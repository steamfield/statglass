import { availableMetrics, newRule, ruleSummary } from "@core/alerts";
import {
  ALERT_LIMITS,
  type AlertMetric,
  type AlertRule,
  type UnitSettings,
} from "@core/generated/bindings";
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
    ["a percent", rule("mem.pressure", { value: 85 }), METRIC_UNITS],
    ["a temperature in °F", rule("thermal.hottest"), DISPLAY_UNITS],
    ["memory bytes in GiB", rule("mem.swap_used"), DISPLAY_UNITS],
    ["one volume", rule("disk.free", { value: 50e9 }), METRIC_UNITS],
    ["one fan", rule("fan.rpm", { labels: [["fan", "1"]] }), METRIC_UNITS],
    ["a page rate", rule("mem.swap_out"), METRIC_UNITS],
    [
      "every series of a labelled metric",
      rule("fan.rpm", { labels: [] }),
      METRIC_UNITS,
    ],
  ])("stores %s rule as it read it", (_kind, stored, units) => {
    const back = ruleFromForm(formFromRule(stored, units), units);
    const got = thresholdOf(back);
    const want = thresholdOf(stored);
    // Unit conversion leaves float noise; everything else is exact.
    expect({
      ...back,
      when: { threshold: { ...got, value: want.value } },
    }).toEqual(stored);
    expect(Math.abs((got.value ?? 0) - (want.value ?? 0))).toBeLessThan(
      Math.abs(want.value ?? 1) * 1e-6
    );
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
      forSecs: 0,
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
  const cpu: RuleForm = {
    id: ID,
    name: "CPU usage above 90% for 5 min",
    autoName: true,
    metric: "cpu.total",
    labels: {},
    op: "gt",
    shown: "90",
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
