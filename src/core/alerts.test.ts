import {
  alertCauseLabel,
  availableMetrics,
  COOLDOWN_CHOICES_SECS,
  FOR_CHOICES_SECS,
  lastFiredByRule,
  newRule,
  ruleSummary,
  seriesChoices,
  seriesName,
  thresholdFromDisplay,
  thresholdToDisplay,
} from "./alerts";
import { eventLabel } from "./events";
import {
  ALERT_METRICS,
  type AlertCause,
  type AlertMetric,
  type AlertRule,
  type Cmp,
  type Event,
  type UnitSettings,
} from "./generated/bindings";

const CELSIUS_DECIMAL: UnitSettings = {
  temperature: "celsius",
  network: "bytes_per_sec",
  memory: "decimal",
};

const FAHRENHEIT_BINARY: UnitSettings = {
  temperature: "fahrenheit",
  network: "bytes_per_sec",
  memory: "binary",
};

function rule(
  metric: string,
  labels: [string, string][],
  op: Cmp,
  value: number,
  forSecs: number
): AlertRule {
  return {
    id: "c0ffee00-0000-4000-8000-000000000001",
    name: "My rule",
    when: { threshold: { series: { metric, labels }, op, value } },
    for_secs: forSecs,
    cooldown_secs: 1800,
    enabled: true,
  };
}

function threshold(
  metric: string,
  labels: [string, string][],
  value: number,
  op: Cmp,
  limit: number,
  forSecs: number
): AlertCause {
  return {
    type: "threshold",
    metric,
    labels,
    value,
    op,
    threshold: limit,
    for_secs: forSecs,
  };
}

function metric(id: string): AlertMetric {
  const m = ALERT_METRICS.find((x) => x.metric === id);
  if (!m) throw new Error(`${id} is not alertable`);
  return {
    ...m,
    default_label: m.default_label ? [...m.default_label] : null,
  };
}

function alert(ts: number, ruleId: string): Event {
  return {
    ts_ms: ts,
    start_ms: ts - 60_000,
    processes: [],
    detail: {
      kind: "alert",
      rule_id: ruleId,
      rule_name: "r",
      cause: threshold("mem.pressure", [], 90, "gt", 80, 120),
    },
  };
}

describe("ruleSummary", () => {
  it("matches the Rust sentence for each comparison", () => {
    const s = (m: string, op: Cmp, v: number, f: number) =>
      ruleSummary(rule(m, [], op, v, f), CELSIUS_DECIMAL);
    expect(s("mem.pressure", "gt", 80, 120)).toBe(
      "Memory pressure above 80% for 2 min"
    );
    expect(s("mem.pressure", "ge", 80, 120)).toBe(
      "Memory pressure above 80% for 2 min"
    );
    expect(s("battery.charge", "lt", 20, 300)).toBe(
      "Battery charge below 20% for 5 min"
    );
    expect(s("battery.charge", "le", 20, 300)).toBe(
      "Battery charge below 20% for 5 min"
    );
  });

  it("leaves out a zero duration and counts short ones in seconds", () => {
    const s = (m: string, op: Cmp, v: number, f: number) =>
      ruleSummary(rule(m, [], op, v, f), CELSIUS_DECIMAL);
    expect(s("battery.charge", "lt", 20, 0)).toBe("Battery charge below 20%");
    expect(s("cpu.total", "gt", 90, 30)).toBe("CPU usage above 90% for 30 s");
    expect(s("cpu.total", "gt", 90, 120)).toBe("CPU usage above 90% for 2 min");
  });

  it("names the series a labelled rule watches", () => {
    expect(
      ruleSummary(
        rule("fan.rpm", [["fan", "0"]], "gt", 4000, 0),
        CELSIUS_DECIMAL
      )
    ).toBe("Fan speed (Fan 1) above 4,000 rpm");
    expect(
      ruleSummary(
        rule("disk.free", [["vol", "/"]], "lt", 20e9, 0),
        CELSIUS_DECIMAL
      )
    ).toBe("Free disk space (/) below 20 GB");
  });

  it("follows the memory unit for memory and the temperature unit", () => {
    const swap = rule("mem.swap_used", [], "gt", 4e9, 300);
    expect(ruleSummary(swap, CELSIUS_DECIMAL)).toBe(
      "Swap used above 4 GB for 5 min"
    );
    expect(ruleSummary(swap, FAHRENHEIT_BINARY)).toBe(
      "Swap used above 3.7 GiB for 5 min"
    );
    expect(
      ruleSummary(
        rule("disk.free", [["vol", "/"]], "lt", 20e9, 0),
        FAHRENHEIT_BINARY
      )
    ).toBe("Free disk space (/) below 20 GB");
    expect(
      ruleSummary(rule("thermal.hottest", [], "gt", 95, 120), FAHRENHEIT_BINARY)
    ).toBe("Hottest sensor above 203 °F for 2 min");
  });
});

describe("alertCauseLabel", () => {
  it("names the metric, its series and the value in the user's units", () => {
    expect(
      alertCauseLabel(
        threshold("mem.pressure", [], 84.2, "gt", 80, 120),
        CELSIUS_DECIMAL
      )
    ).toBe("Memory pressure 84%");
    expect(
      alertCauseLabel(
        threshold("fan.rpm", [["fan", "1"]], 5200, "gt", 4000, 120),
        CELSIUS_DECIMAL
      )
    ).toBe("Fan speed (Fan 2) 5,200 rpm");
    expect(
      alertCauseLabel(
        threshold("thermal.hottest", [], 97, "gt", 95, 120),
        FAHRENHEIT_BINARY
      )
    ).toBe("Hottest sensor 207 °F");
  });

  it("labels a threshold alert on the Timeline", () => {
    const e: Event = {
      ts_ms: 0,
      start_ms: -120_000,
      processes: [],
      detail: {
        kind: "alert",
        rule_id: "c0ffee00-0000-4000-8000-000000000001",
        rule_name: "Memory is tight",
        cause: threshold("mem.pressure", [], 84.2, "gt", 80, 120),
      },
    };
    expect(eventLabel(e)).toBe("Alert · Memory pressure 84%");
  });
});

describe("threshold display units", () => {
  it("round-trips Celsius through °F", () => {
    expect(
      thresholdToDisplay("thermal.hottest", 95, FAHRENHEIT_BINARY)
    ).toEqual({ value: 203, unit: "°F" });
    expect(
      thresholdFromDisplay("thermal.hottest", 203, FAHRENHEIT_BINARY)
    ).toBeCloseTo(95, 6);
  });

  it("round-trips memory bytes through GiB with the binary setting", () => {
    expect(
      thresholdToDisplay("mem.swap_used", 4 * 2 ** 30, FAHRENHEIT_BINARY)
    ).toEqual({ value: 4, unit: "GiB" });
    expect(thresholdFromDisplay("mem.swap_used", 4, FAHRENHEIT_BINARY)).toBe(
      4 * 2 ** 30
    );
  });

  it("keeps disk bytes in decimal GB whatever the memory setting", () => {
    expect(thresholdToDisplay("disk.free", 20e9, FAHRENHEIT_BINARY)).toEqual({
      value: 20,
      unit: "GB",
    });
    expect(thresholdFromDisplay("disk.free", 20, FAHRENHEIT_BINARY)).toBe(20e9);
  });
});

describe("availableMetrics", () => {
  it("offers only metrics with a live series, in list order", () => {
    const keys = [
      "cpu.total",
      "cpu.user",
      "mem.pressure",
      "fan.rpm{fan=0}",
      "disk.free{vol=/}",
    ];
    expect(availableMetrics(keys).map((m) => m.metric)).toEqual([
      "cpu.total",
      "mem.pressure",
      "fan.rpm",
      "disk.free",
    ]);
  });
});

describe("seriesChoices", () => {
  it("offers Any, then each live series by name", () => {
    const keys = ["fan.rpm{fan=0}", "fan.rpm{fan=1}", "mem.pressure"];
    expect(seriesChoices("fan.rpm", keys)).toEqual([
      { label: "Any", labels: {} },
      { label: "Fan 1", labels: { fan: "0" } },
      { label: "Fan 2", labels: { fan: "1" } },
    ]);
    expect(
      seriesChoices("disk.free", [
        "disk.free{vol=/}",
        "disk.free{vol=/Volumes/Data}",
      ])
    ).toEqual([
      { label: "Any", labels: {} },
      { label: "/", labels: { vol: "/" } },
      { label: "/Volumes/Data", labels: { vol: "/Volumes/Data" } },
    ]);
  });
});

describe("seriesName", () => {
  it("numbers fans from one and names other series by their value", () => {
    expect(seriesName("fan.rpm", { fan: "0" })).toBe("Fan 1");
    expect(seriesName("disk.free", { vol: "/" })).toBe("/");
    expect(seriesName("mem.pressure", {})).toBeNull();
  });
});

describe("newRule", () => {
  it("starts a disk rule on the boot volume with the metric's defaults", () => {
    const r = newRule(metric("disk.free"), "id-1");
    expect(r).toMatchObject({
      id: "id-1",
      when: {
        threshold: {
          series: { metric: "disk.free", labels: [["vol", "/"]] },
          op: "lt",
          value: 20e9,
        },
      },
      for_secs: 0,
      cooldown_secs: 1800,
      enabled: true,
    });
  });

  it("watches every series of a metric without a default label", () => {
    const r = newRule(metric("mem.pressure"), "id-2");
    expect(r.when).toEqual({
      threshold: {
        series: { metric: "mem.pressure", labels: [] },
        op: "gt",
        value: 80,
      },
    });
    expect(r.for_secs).toBe(120);
  });
});

describe("lastFiredByRule", () => {
  it("keeps the newest alert per rule and ignores other events", () => {
    const events: Event[] = [
      alert(3000, "a"),
      alert(1000, "b"),
      alert(1000, "a"),
      {
        ts_ms: 9000,
        start_ms: 8000,
        processes: [],
        detail: { kind: "fans_ramped", from_rpm: 1, to_rpm: 2 },
      },
    ];
    expect(lastFiredByRule(events)).toEqual(
      new Map([
        ["a", 3000],
        ["b", 1000],
      ])
    );
  });
});

describe("rule dialog choices", () => {
  it("offers the durations and cooldowns the dialog lists", () => {
    expect(FOR_CHOICES_SECS).toEqual([0, 30, 60, 120, 300, 600, 1800]);
    expect(COOLDOWN_CHOICES_SECS).toEqual([
      60, 300, 900, 1800, 3600, 21_600, 86_400,
    ]);
  });
});
