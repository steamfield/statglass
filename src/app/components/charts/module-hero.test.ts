import { formatBytes } from "@core/format";
import type { MetricStat } from "@core/generated/bindings";
import {
  CPU_HERO,
  GPU_HERO,
  MEMORY_PRESSURE_HERO,
  memoryUsedHero,
  NETWORK_HERO,
  POWER_HERO,
} from "./module-hero";
import { BYTES_GUTTER } from "./module-history-chart";

const stat: MetricStat = {
  metric: "",
  avg: 12.34,
  max: 56.78,
  integral: 6e9,
  measured_ms: 1000,
};

describe("module hero specs", () => {
  it("draws CPU total before system with the original percent axis and subject", () => {
    expect(CPU_HERO.module).toBe("cpu");
    expect(CPU_HERO.keys).toEqual(["cpu.total", "cpu.system"]);
    expect(CPU_HERO.subject).toBe("CPU total and system");
    expect(CPU_HERO.yAxis).toBe("percent");
    expect(
      CPU_HERO.lines({ "cpu.total": [20, null], "cpu.system": [5, 3] })
    ).toEqual([
      { key: "cpu.total", values: [20, null], step: 1 },
      { key: "cpu.system", values: [5, 3], step: 2 },
    ]);
  });

  it.each([
    [GPU_HERO, "gpu", "gpu.util", "GPU utilization"],
    [MEMORY_PRESSURE_HERO, "memory", "mem.pressure", "Memory pressure"],
  ])("draws the single percent series for $1", (spec, module, key, subject) => {
    expect(spec.module).toBe(module);
    expect(spec.keys).toEqual([key]);
    expect(spec.subject).toBe(subject);
    expect(spec.yAxis).toBe("percent");
    expect(spec.lines({ [key]: [12, null, 0] })).toEqual([
      { key, values: [12, null, 0], step: 1 },
    ]);
  });

  it("draws the emphasized system power line on the original watts scale", () => {
    expect(POWER_HERO.module).toBe("power");
    expect(POWER_HERO.keys).toEqual(["power.system"]);
    expect(POWER_HERO.subject).toBe("System power");
    expect(POWER_HERO.lines({ "power.system": [10, null, 0] })).toEqual([
      { key: "power.system", values: [10, null, 0], step: 1, weight: 2 },
    ]);
    expect(POWER_HERO.yAxis).toMatchObject({ ceiling: "auto", min: 5 });
    expect(POWER_HERO.yAxis.format(12)).toBe("12W");
  });

  it.each([CPU_HERO, GPU_HERO, MEMORY_PRESSURE_HERO, POWER_HERO])(
    "keeps missing series empty for $module",
    (spec) => {
      expect(spec.lines({}).map((line) => line.values)).toEqual(
        spec.keys.map(() => [])
      );
    }
  );

  it.each([CPU_HERO, GPU_HERO, POWER_HERO])(
    "keeps the original totals for $module",
    (spec) => {
      expect(
        spec.totals.map(({ metric, label }) => ({ metric, label }))
      ).toEqual([
        { metric: spec.keys[0], label: "Avg" },
        { metric: spec.keys[0], label: "Peak" },
      ]);
      expect(spec.totals.map((total) => total.format(stat))).toEqual(
        spec === POWER_HERO ? ["12.3 W", "56.8 W"] : ["12.3%", "57%"]
      );
    }
  );

  it("stacks cached over used, right-aligning and preserving gaps and zero", () => {
    const format = (v: number) => formatBytes(v, { units: "GiB" });
    const spec = memoryUsedHero(16 * 1024 ** 3, format);
    expect(spec.module).toBe("memory");
    expect(spec.keys).toEqual(["mem.used", "mem.cached"]);
    expect(spec.subject).toBe("Memory used and cached files");
    expect(spec.yAxis).toEqual({
      ceiling: 16 * 1024 ** 3,
      format,
      gutter: BYTES_GUTTER,
    });
    if (spec.yAxis === "percent") throw new Error("Expected byte axis");
    expect(spec.yAxis.format(2 * 1024 ** 3)).toBe("2.0 GiB");
    expect(
      spec.lines({
        "mem.used": [99, 10, null, 0, 3],
        "mem.cached": [2, 4, 0, null],
      })
    ).toEqual([
      { key: "mem.cached", values: [12, null, 0, null], step: 4 },
      { key: "mem.used", values: [99, 10, null, 0, 3], step: 1 },
    ]);
    expect(
      spec.lines({ "mem.used": [10, 20], "mem.cached": [99, 1, 2] })[0]?.values
    ).toEqual([11, 22]);
    expect(spec.lines({}).map((line) => line.values)).toEqual([[], []]);
    expect(spec.totals).toBeUndefined();
    expect("totals" in MEMORY_PRESSURE_HERO).toBe(false);
  });

  it("keeps Network directions, minimum ceiling and integrated byte totals", () => {
    expect(NETWORK_HERO).toMatchObject({
      upKey: "net.tx_total",
      downKey: "net.rx_total",
      upLabel: "Upload",
      downLabel: "Download",
      subject: "Network",
      minCeiling: 100_000,
    });
    expect(
      NETWORK_HERO.totals.map(({ metric, label }) => ({ metric, label }))
    ).toEqual([
      { metric: "net.rx_total", label: "↓ Downloaded" },
      { metric: "net.tx_total", label: "↑ Uploaded" },
    ]);
    expect(NETWORK_HERO.totals.map((total) => total.format(stat))).toEqual([
      "6.0 GB",
      "6.0 GB",
    ]);
  });
});
