import { thresholdFromDisplay, thresholdToDisplay } from "./alert-values";
import { ruleSummary, seriesName } from "./alerts";
import type { AlertRule, UnitSettings } from "./generated/bindings";

const FAHRENHEIT_BINARY: UnitSettings = {
  temperature: "fahrenheit",
  network: "bytes_per_sec",
  memory: "binary",
};

const CELSIUS_DECIMAL: UnitSettings = {
  temperature: "celsius",
  network: "bytes_per_sec",
  memory: "decimal",
};

/** A threshold entered in the dialog, saved by Rust as f32 and read back. */
function savedAndReadBack(metric: string, shown: number, units: UnitSettings) {
  const stored = Math.fround(thresholdFromDisplay(metric, shown, units));
  return thresholdToDisplay(metric, stored, units);
}

function memoryRule(forSecs: number): AlertRule {
  return {
    id: "c0ffee00-0000-4000-8000-000000000001",
    name: "Memory",
    when: {
      threshold: {
        series: { metric: "mem.pressure", labels: [] },
        op: "gt",
        value: 80,
      },
    },
    for_secs: forSecs,
    cooldown_secs: 1800,
    enabled: true,
  };
}

describe("thresholds read back from f32 storage", () => {
  it("shows an entered °F threshold as entered", () => {
    expect(savedAndReadBack("thermal.hottest", 200, FAHRENHEIT_BINARY)).toEqual(
      { value: 200, unit: "°F" }
    );
  });

  it("shows an entered GiB threshold as entered", () => {
    expect(savedAndReadBack("mem.swap_used", 3.7, FAHRENHEIT_BINARY)).toEqual({
      value: 3.7,
      unit: "GiB",
    });
  });

  it("cuts a converted default to seven significant digits", () => {
    expect(
      thresholdToDisplay("mem.swap_used", Math.fround(4e9), FAHRENHEIT_BINARY)
    ).toEqual({ value: 3.72529, unit: "GiB" });
  });

  it("keeps a threshold in its catalog unit when no conversion applies", () => {
    expect(thresholdToDisplay("fan.rpm", 4000, CELSIUS_DECIMAL)).toEqual({
      value: 4000,
      unit: "rpm",
    });
  });
});

describe("wording parity with Rust", () => {
  it("rounds a hold of two minutes or more down to whole minutes", () => {
    expect(ruleSummary(memoryRule(179), CELSIUS_DECIMAL)).toBe(
      "Memory pressure above 80% for 2 min"
    );
    expect(ruleSummary(memoryRule(119), CELSIUS_DECIMAL)).toBe(
      "Memory pressure above 80% for 119 s"
    );
  });

  it("names a series with several labels by its first label", () => {
    expect(seriesName("disk.free", { dev: "disk3s1", vol: "/" })).toBe(
      "disk3s1"
    );
    expect(seriesName("fan.rpm", { fan: "1", zone: "left" })).toBe("Fan 2");
  });
});
