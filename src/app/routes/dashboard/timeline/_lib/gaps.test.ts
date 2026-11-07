import type { Gap } from "@core/generated/bindings";
import { sleepMarkers, timelineBands } from "./gaps";
import { axisTicks } from "./time";

const at = (h: number, m = 0) => new Date(2026, 9, 4, h, m).getTime();
const sleep = (start: number, end: number | null): Gap => ({
  start_ms: start,
  end_ms: end,
  module: null,
  reason: "sleep",
});

describe("timelineBands", () => {
  it("says how long on 24h and from when to when on 1h", () => {
    const g = sleep(at(1, 40), at(6, 55));
    expect(timelineBands([g], at(0), at(23), "24h")[0]?.label).toBe(
      "Asleep 5h 15m · no samples"
    );
    expect(timelineBands([g], at(0), at(23), "1h")[0]?.label).toBe(
      "Asleep 01:40–06:55 · not interpolated"
    );
  });

  it("keeps one band for the same gap returned by every lane's page", () => {
    const gaps = [
      sleep(at(1, 40), at(6, 55)),
      sleep(at(1, 40) + 3, at(6, 55) + 3),
      sleep(at(1, 40), at(6, 55)),
    ];
    expect(timelineBands(gaps, at(0), at(23), "24h")).toHaveLength(1);
  });

  it("keeps every module's gaps, each scoped to its module", () => {
    const g = (module: "gpu" | "cpu"): Gap => ({
      start_ms: at(3),
      end_ms: at(4),
      module,
      reason: "module_disabled",
    });
    const bands = timelineBands([g("gpu"), g("cpu")], at(0), at(23), "24h");
    expect(bands.map((b) => b.module).sort()).toEqual(["cpu", "gpu"]);
  });
});

describe("sleepMarkers", () => {
  it("puts Sleep at a sleep gap's start and Wake at its end", () => {
    const markers = sleepMarkers([sleep(at(1, 40), at(6, 55))], at(0), at(23));
    expect(markers.map((m) => m.label)).toEqual(["01:40 Sleep", "06:55 Wake"]);
  });

  it("has no Wake for a gap that is still open", () => {
    const markers = sleepMarkers([sleep(at(22), null)], at(0), at(23));
    expect(markers.map((m) => m.kind)).toEqual(["sleep"]);
  });
});

describe("axisTicks", () => {
  it("ticks every 3 hours on the local hour for 24h", () => {
    const ticks = axisTicks(at(0, 30), at(23, 59), "24h");
    expect(ticks.map((t) => t.label)).toEqual([
      "03:00",
      "06:00",
      "09:00",
      "12:00",
      "15:00",
      "18:00",
      "21:00",
    ]);
    // A tick in the last 10% would collide with the "now" label.
    expect(axisTicks(at(0, 30), at(21, 40), "24h").at(-1)?.label).toBe("18:00");
  });

  it("ticks every 10 minutes for 1h and leaves room for the now label", () => {
    const ticks = axisTicks(at(9, 3), at(10, 3), "1h");
    expect(ticks.map((t) => t.label)).toEqual([
      "09:10",
      "09:20",
      "09:30",
      "09:40",
      "09:50",
    ]);
  });
});
