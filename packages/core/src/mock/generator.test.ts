import { seriesKey, seriesKeyString } from "@core/series-key";
import { type ScenarioName, scenarioFlags } from "./fixtures";
import { MockGenerator } from "./generator";

it("rate extremes cycle through real zero, large rates and expired held readings", () => {
  const gen = new MockGenerator(scenarioFlags(["network-rate-extremes"]));
  const index = gen.indexOf("net.rx_total");
  expect(index).toBeGreaterThanOrEqual(0);
  const rows = Array.from({ length: 12 }, () => gen.next());
  expect(rows.slice(0, 4).map((row) => row.values[index])).toEqual([
    0, 0, 0, 0,
  ]);
  for (const row of rows.slice(4, 8))
    expect(row.values[index]).toBeGreaterThanOrEqual(999e9);
  expect(rows[8]?.values[index]).toBeNull();
  expect(rows[8]?.held[index]).toBeGreaterThan(0);
  expect(rows[10]?.held[index]).toBeNull();
  expect(gen.next().held[index]).toBe(0);
});

describe("readings over a sampling period", () => {
  /** Series `metric{labels}`'s reading on a fresh generator's first tick, at `atMs`. */
  function firstReading(
    scenario: ScenarioName,
    metric: string,
    labels: Record<string, string>,
    atMs: number,
    setup: (gen: MockGenerator) => void = () => {}
  ): number | null {
    const gen = new MockGenerator(scenarioFlags([scenario]));
    setup(gen);
    const i = gen.indexOf(seriesKeyString(seriesKey(metric, labels)));
    expect(i).toBeGreaterThanOrEqual(0);
    return gen.next(false, atMs).values[i] ?? null;
  }

  it("follows the clock when it steps backwards", () => {
    const stepped = new MockGenerator(scenarioFlags(["default"]));
    const i = stepped.indexOf("cpu.total");
    stepped.next(false, 1_000_000);
    stepped.next(false, 1_001_000);
    const back = [701_000, 702_000, 703_000];
    const after = back.map((ms) => stepped.next(false, ms).values[i]);
    const fresh = back.map((ms) =>
      firstReading("default", "cpu.total", {}, ms)
    );
    expect(after).toEqual(fresh);
  });

  it("reads a rate sampled every tenth tick as the mean over its ten seconds", () => {
    const at = 1_000_000;
    const en0 = { iface: "en0" };
    const tray = firstReading("default", "net.rx", en0, at, (gen) => {
      gen.trayOnly = true;
    });
    const slow = firstReading("default", "net.rx", en0, at, (gen) => {
      gen.intervalMs = 10_000;
    });
    expect(tray).not.toBeNull();
    expect(tray).toBe(slow);
  });

  it.each([
    ["default", "cpu.loadavg", { window: "1" }],
    ["linux", "cpu.psi", { stall: "some" }],
    ["linux", "disk.psi", { stall: "some" }],
  ] as const)(
    "reads the %s gauge %s at the instant at any interval",
    (scenario, metric, labels) => {
      const at = 1_000_000;
      const fast = firstReading(scenario, metric, labels, at);
      const slow = firstReading(scenario, metric, labels, at, (gen) => {
        gen.intervalMs = 5000;
      });
      expect(fast).not.toBeNull();
      expect(slow).toBe(fast);
    }
  );
});
