import type { Settings } from "@core/generated/bindings";
import { defaultSettings, scenarioFlags } from "@core/mock/fixtures";
import { menuBarOf } from "@core/settings-patch";
import {
  appKeys,
  diskSpaceKeys,
  dockerKeys,
  historyKeys,
  hostKeys,
  sameDiskIo,
  sameDockerComparison,
  sameDockerContainer,
  sameHeatmapMetric,
  sameHost,
  sameModuleSeries,
  sameRingGaps,
  sameSpaceReport,
  settingsInvalidation,
} from "./query-keys";

const H = "h1";
const base = defaultSettings(scenarioFlags(["default"]));
const RANGE = { windowMs: 3600000, endMs: null, bucketMs: 10_000 } as const;

const KEYS = {
  historyRange: historyKeys.range(H, "cpu", RANGE, "auto"),
  historySize: hostKeys.historySize(H),
  historyHealth: hostKeys.historyHealth(H),
  hostDetail: hostKeys.detail(H),
  capabilities: hostKeys.capabilities(H),
  sensorDump: hostKeys.sensorDump(H),
  appearance: appKeys.appearance,
};

/** The names of the keys a change from `prev` to `next` invalidates. */
function stale(next: Settings, prev: Settings | null = base): string[] {
  const match = settingsInvalidation(prev, next);
  return Object.entries(KEYS)
    .filter(([, key]) => match(key))
    .map(([name]) => name);
}

describe("settingsInvalidation", () => {
  it("retention or size limit: history, its size and its health", () => {
    const next = { ...base, history: { ...base.history, retention_days: 7 } };
    expect(stale(next)).toEqual([
      "historyRange",
      "historySize",
      "historyHealth",
    ]);
  });

  it("a module switch: history (module_disabled gaps) and size", () => {
    const next: Settings = {
      ...base,
      modules: { ...base.modules, gpu: { enabled: false } },
    };
    expect(stale(next)).toEqual(["historyRange", "historySize"]);
  });

  it("a menu bar change alone invalidates nothing", () => {
    const menu_bar = menuBarOf(base);
    const next: Settings = {
      ...base,
      menu_bar: {
        ...menu_bar,
        readouts: { ...menu_bar.readouts, power: !menu_bar.readouts.power },
      },
    };
    expect(stale(next)).toEqual([]);
  });

  it("the interval: the size projection only", () => {
    const next = { ...base, sampling: { ...base.sampling, interval_ms: 2000 } };
    expect(stale(next)).toEqual(["historySize"]);
  });

  it("the update switch invalidates nothing: the update check is not a query", () => {
    const next = {
      ...base,
      general: { ...base.general, check_updates: false },
    };
    expect(stale(next)).toEqual([]);
  });

  it("appearance, units and onboarding invalidate nothing", () => {
    expect(
      stale({ ...base, general: { ...base.general, appearance: "dark" } })
    ).toEqual([]);
    expect(
      stale({ ...base, units: { ...base.units, temperature: "fahrenheit" } })
    ).toEqual([]);
    expect(stale({ ...base, onboarding: { completed: false } })).toEqual([]);
    expect(stale(structuredClone(base))).toEqual([]);
  });

  it("the heatmap is history: retention drops it, the interval does not", () => {
    const hour = new Date(2026, 9, 4, 14).getTime();
    const key = historyKeys.heatmap(H, "cpu", hour, 30);
    expect(key.slice(0, 2)).toEqual(historyKeys.host(H));
    const retention = settingsInvalidation(base, {
      ...base,
      history: { ...base.history, retention_days: 7 },
    });
    const interval = settingsInvalidation(base, {
      ...base,
      sampling: { ...base.sampling, interval_ms: 2000 },
    });
    expect(retention(key)).toBe(true);
    expect(interval(key)).toBe(false);
    expect(key).not.toEqual(historyKeys.heatmap(H, "temp", hour, 30));
  });

  it("with no previous settings every dependent key is stale", () => {
    expect(stale(base, null)).toEqual([
      "historyRange",
      "historySize",
      "historyHealth",
    ]);
  });
});

describe("history keys", () => {
  it("every history key, Docker history included, starts with the host", () => {
    const keys = [
      historyKeys.moduleSeries(H, ["cpu.total"], 60_000, 0, 60),
      historyKeys.diskIo(H, null, 0, 1, 10),
      historyKeys.historicalUsage(H, 0, 1, "cpu", []),
      historyKeys.usageProcessRange(H, 0, 1),
      historyKeys.usageProcesses(H, 0, 1, "cpu", "app"),
      dockerKeys.history(H, "e", null, 0, 1, 0),
      dockerKeys.comparison(H, "e", 0, 1, "cpu", null, null, 0),
      dockerKeys.events(H, "e", null, 0, 1, 0, null),
      dockerKeys.retained(H, null, "", 0, 0),
      dockerKeys.detail(H, "e", "c", 0),
    ];
    for (const key of keys)
      expect(key.slice(0, 2)).toEqual(historyKeys.host(H));
  });
});

describe("hold identity predicates", () => {
  const OTHER = "h2";

  it("never hold across a host switch", () => {
    const pairs: [readonly unknown[], readonly unknown[], typeof sameHost][] = [
      [
        historyKeys.events(H, 1, null),
        historyKeys.events(OTHER, 1, null),
        sameHost,
      ],
      [
        historyKeys.moduleSeries(H, ["a"], 60, 10, 6),
        historyKeys.moduleSeries(OTHER, ["a"], 60, 20, 6),
        sameModuleSeries,
      ],
      [
        historyKeys.ringGaps(H, false),
        historyKeys.ringGaps(OTHER, false),
        sameRingGaps,
      ],
      [
        historyKeys.diskIo(H, "disk0", 0, 10, 5),
        historyKeys.diskIo(OTHER, "disk0", 10, 20, 5),
        sameDiskIo,
      ],
      [
        historyKeys.heatmap(H, "cpu", 0, 30),
        historyKeys.heatmap(OTHER, "cpu", 1, 30),
        sameHeatmapMetric,
      ],
      [
        diskSpaceKeys.subtree(H, 1, null, false),
        diskSpaceKeys.subtree(OTHER, 1, 2, false),
        sameSpaceReport,
      ],
      [
        dockerKeys.history(H, "e", null, 0, 1, 0),
        dockerKeys.history(OTHER, "e", null, 1, 2, 0),
        sameDockerContainer,
      ],
      [
        dockerKeys.comparison(H, "e", 0, 1, "cpu", null, null, 0),
        dockerKeys.comparison(OTHER, "e", 1, 2, "cpu", null, null, 0),
        sameDockerComparison,
      ],
    ];
    for (const [a, b, same] of pairs) {
      expect(same(a, a)).toBe(true);
      expect(same(a, b)).toBe(false);
    }
  });

  it("a live module chart holds while its end moves, not for a fixed end or other series", () => {
    const live = historyKeys.moduleSeries(H, ["a"], 60, 10, 6);
    expect(
      sameModuleSeries(live, historyKeys.moduleSeries(H, ["a"], 60, 20, 6))
    ).toBe(true);
    expect(
      sameModuleSeries(live, historyKeys.moduleSeries(H, ["b"], 60, 20, 6))
    ).toBe(false);
    expect(
      sameModuleSeries(live, historyKeys.moduleSeries(H, ["a"], 60, 20, 7))
    ).toBe(false);
    expect(
      sameModuleSeries(
        live,
        historyKeys.moduleSeries(H, ["a"], 60, 20, 6, true)
      )
    ).toBe(false);
  });

  it("ring gaps hold across a pause, not for a fixed end or another window", () => {
    const live = historyKeys.ringGaps(H, false, 60);
    expect(sameRingGaps(live, historyKeys.ringGaps(H, true, 60))).toBe(true);
    expect(sameRingGaps(live, historyKeys.ringGaps(H, false, 120))).toBe(false);
    expect(sameRingGaps(live, historyKeys.ringGaps(H, false, 60, 5))).toBe(
      false
    );
  });

  it("disk I/O holds for the same device and span only", () => {
    const key = historyKeys.diskIo(H, "disk0", 0, 10, 5);
    expect(sameDiskIo(key, historyKeys.diskIo(H, "disk0", 10, 20, 5))).toBe(
      true
    );
    expect(sameDiskIo(key, historyKeys.diskIo(H, "disk1", 10, 20, 5))).toBe(
      false
    );
    expect(sameDiskIo(key, historyKeys.diskIo(H, "disk0", 10, 30, 5))).toBe(
      false
    );
  });

  it("the heatmap and a report hold within their own identity", () => {
    expect(
      sameHeatmapMetric(
        historyKeys.heatmap(H, "cpu", 0, 30),
        historyKeys.heatmap(H, "temp", 0, 30)
      )
    ).toBe(false);
    expect(
      sameSpaceReport(
        diskSpaceKeys.subtree(H, 1, null, false),
        diskSpaceKeys.subtree(H, 1, 4, true)
      )
    ).toBe(true);
    expect(
      sameSpaceReport(
        diskSpaceKeys.subtree(H, 1, null, false),
        diskSpaceKeys.subtree(H, 2, null, false)
      )
    ).toBe(false);
  });

  it("Docker history holds within one container; a comparison within one metric", () => {
    const history = dockerKeys.history(H, "e", "a", 0, 1, 0);
    expect(
      sameDockerContainer(history, dockerKeys.history(H, "e", "a", 1, 2, 1))
    ).toBe(true);
    expect(
      sameDockerContainer(history, dockerKeys.history(H, "e", "b", 0, 1, 0))
    ).toBe(false);
    expect(
      sameDockerContainer(history, dockerKeys.history(H, "f", "a", 0, 1, 0))
    ).toBe(false);
    expect(
      sameDockerContainer(
        dockerKeys.events(H, "e", "a", 0, 1, 0, null),
        dockerKeys.events(H, "e", "b", 0, 1, 0, null)
      )
    ).toBe(false);
    const comparison = dockerKeys.comparison(
      H,
      "e",
      0,
      1,
      "cpu",
      null,
      null,
      0
    );
    expect(
      sameDockerComparison(
        comparison,
        dockerKeys.comparison(H, "e", 1, 2, "cpu", "p", ["c"], 1)
      )
    ).toBe(true);
    expect(
      sameDockerComparison(
        comparison,
        dockerKeys.comparison(H, "e", 0, 1, "memory", null, null, 0)
      )
    ).toBe(false);
    expect(
      sameDockerComparison(
        comparison,
        dockerKeys.comparison(H, "f", 0, 1, "cpu", null, null, 0)
      )
    ).toBe(false);
  });

  it("the public address and Docker operations sit under their family prefixes", () => {
    expect(appKeys.publicIp("en0", null, null).slice(0, 2)).toEqual(
      appKeys.publicIpAll
    );
    expect(dockerKeys.storage("e", 0)[0]).toBe(dockerKeys.all[0]);
    expect(dockerKeys.operation("e")[0]).toBe(dockerKeys.all[0]);
  });
});
