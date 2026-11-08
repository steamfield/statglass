import { formatBytes } from "@core/format";
import type { MetricStat } from "@core/generated/bindings";
import {
  CPU_HERO,
  GPU_HERO,
  MEMORY_PRESSURE_HERO,
  memoryHero,
  memoryUsedHero,
  NETWORK_HERO,
  POWER_HERO,
} from "./module-hero";

const stat: MetricStat = {
  metric: "",
  avg: 12.34,
  max: 56.78,
  integral: 6e9,
  measured_ms: 1000,
};

describe("module hero behavior", () => {
  it.each([CPU_HERO, GPU_HERO, MEMORY_PRESSURE_HERO, POWER_HERO])(
    "keeps missing series empty for $module",
    (spec) => {
      const lines = spec.lines({});
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.values).toEqual([]);
    }
  );

  it.each([CPU_HERO, GPU_HERO, POWER_HERO])(
    "formats the average and peak for $module",
    (spec) => {
      expect(spec.totals.map((total) => total.format(stat))).toEqual(
        spec === POWER_HERO ? ["12.3 W", "56.8 W"] : ["12.3%", "57%"]
      );
    }
  );

  it("stacks cached over used, right-aligning and preserving gaps and zero", () => {
    const spec = memoryUsedHero(16 * 1024 ** 3, (v) =>
      formatBytes(v, { units: "GiB" })
    );
    expect(
      spec
        .lines({
          "mem.used": [99, 10, null, 0, 3],
          "mem.cached": [2, 4, 0, null],
        })
        .map((line) => line.values)
    ).toEqual([
      [12, null, 0, null],
      [99, 10, null, 0, 3],
    ]);
    expect(
      spec.lines({ "mem.used": [10, 20], "mem.cached": [99, 1, 2] })[0]?.values
    ).toEqual([11, 22]);
    expect(spec.lines({}).map((line) => line.values)).toEqual([[], []]);
  });

  it("formats integrated Network byte totals", () => {
    expect(NETWORK_HERO.totals.map((total) => total.format(stat))).toEqual([
      "6.0 GB",
      "6.0 GB",
    ]);
  });

  it.each([undefined, "mac_os", "linux"] as const)(
    "selects the memory chart by host OS %s",
    (os) => {
      const spec = memoryHero(
        os === undefined ? undefined : { os, mem_total_bytes: 16e9 },
        String
      );
      const lines = spec.lines({
        "mem.pressure": [7],
        "mem.used": [10],
        "mem.cached": [2],
      });
      expect(lines.map((line) => line.values)).toEqual(
        os === "linux" ? [[12], [10]] : [[7]]
      );
    }
  );
});
