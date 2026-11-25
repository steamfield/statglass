import {
  INLINE_BAR,
  MEMORY_STACK,
  POWER_STACK_BAR,
} from "@core/widget-models/fixtures/bars";
import { inlineBarModel } from "@core/widget-models/inline-bar";
import { meterTrackModel } from "@core/widget-models/meter-track";
import { mirrorBarsModel } from "@core/widget-models/mirror-bars";
import { stackBarModel } from "@core/widget-models/stack-bar";
import { describe, expect, it } from "vitest";

describe("stack bar", () => {
  it("retains the accessible name without building rows for a hidden legend", () => {
    const model = stackBarModel(POWER_STACK_BAR);
    expect(model.ariaLabel).toContain("ANE 0.0 W");
    expect(model.legend).toEqual([]);
  });

  it("keeps the memory composition, its ramp, and Swap in the legend", () => {
    expect(stackBarModel(MEMORY_STACK)).toEqual({
      ariaLabel:
        "Wired 3.9 GB, App 11.6 GB, Compressed 2.1 GB, Cached files 4.0 GB, Free 2.4 GB",
      empty: false,
      segments: [
        {
          key: "wired",
          grow: 3.9 / 24,
          color: { kind: "accent", accent: "mem", step: 1, ink: false },
          track: false,
        },
        {
          key: "app",
          grow: 11.6 / 24,
          color: { kind: "accent", accent: "mem", step: 2, ink: false },
          track: false,
        },
        {
          key: "compressed",
          grow: 2.1 / 24,
          color: { kind: "hatch", accent: "mem" },
          track: false,
        },
        {
          key: "cached",
          grow: 4 / 24,
          color: { kind: "accent", accent: "mem", step: 4, ink: false },
          track: false,
        },
        {
          key: "free",
          grow: 2.4 / 24,
          color: { kind: "token", name: "track" },
          track: true,
        },
      ],
      legend: [
        { key: "wired", label: "Wired", value: "3.9 GB", swatch: 1 },
        { key: "app", label: "App", value: "11.6 GB", swatch: 2 },
        {
          key: "compressed",
          label: "Compressed",
          value: "2.1 GB",
          swatch: "hatch",
        },
        { key: "cached", label: "Cached files", value: "4.0 GB", swatch: 4 },
        { key: "free", label: "Free", value: "2.4 GB", swatch: "track" },
        { key: "extra-0", label: "Swap", value: "512 MB", swatch: "none" },
      ],
    });
  });

  it("keeps zero and missing readings in the legend and clamps drawn fractions", () => {
    const segments = POWER_STACK_BAR.segments.map((segment, index) => ({
      ...segment,
      fraction: [1.5, null, 0, -0.2, 0.5][index] ?? null,
    }));
    const model = stackBarModel({
      ...POWER_STACK_BAR,
      segments,
      showLegend: true,
      ariaLabel: "System power split",
    });
    expect(model.ariaLabel).toBe("System power split");
    expect(model.empty).toBe(false);
    expect(model.segments.map(({ key, grow }) => [key, grow])).toEqual([
      ["cpu", 1],
      ["rest", 0.5],
    ]);
    expect(model.legend.map(({ key }) => key)).toEqual([
      "cpu",
      "gpu",
      "ane",
      "dram",
      "rest",
    ]);
  });

  it("distinguishes an empty track from an all-zero stack", () => {
    const models = [null, 0].map((fraction) =>
      stackBarModel({
        segments: POWER_STACK_BAR.segments.map((segment) => ({
          ...segment,
          fraction,
        })),
      })
    );
    expect(models.map(({ empty, segments }) => ({ empty, segments }))).toEqual([
      { empty: true, segments: [] },
      { empty: false, segments: [] },
    ]);
  });
});

describe("meter tracks", () => {
  it("keeps a measured zero distinct from a missing fill", () => {
    const model = [null, 0, 1.7].map((fraction) =>
      meterTrackModel({ fraction })
    );
    expect(model).toEqual([
      { fill: null, color: { kind: "accent", step: 1, ink: false } },
      { fill: 0, color: { kind: "accent", step: 1, ink: false } },
      { fill: 1, color: { kind: "accent", step: 1, ink: false } },
    ]);
  });

  it("distinguishes a missing inline fill from a row with no track", () => {
    const models = ([0.71, null, "none"] as const).map((fraction) =>
      inlineBarModel({ ...INLINE_BAR, fraction, rampStep: "hatch" })
    );
    expect(models).toEqual([
      {
        label: "P-cluster",
        value: "3.2 GHz",
        layout: "stacked",
        track: { fill: 0.71, color: { kind: "hatch", accent: "cpu" } },
      },
      {
        label: "P-cluster",
        value: "3.2 GHz",
        layout: "stacked",
        track: { fill: null, color: { kind: "hatch", accent: "cpu" } },
      },
      { label: "P-cluster", value: "3.2 GHz", layout: "stacked", track: null },
    ]);
  });
});

describe("mirrored bars", () => {
  const network = {
    up: [5, null, 0, 15],
    down: [100, Number.NaN, 10],
    intervalMs: 1000,
    upMax: 10,
    downMax: 200,
    downHeight: 40,
    accent: "net",
    ariaLabel: "Network, last four seconds",
  } as const;
  const colors = {
    upColor: { kind: "accent", accent: "net", step: 2, ink: false },
    downColor: { kind: "accent", accent: "net", step: 1, ink: false },
    ariaLabel: network.ariaLabel,
  };

  it("scales each side to its ceiling and keeps gaps and zero at their slots", () => {
    expect(mirrorBarsModel(network)).toEqual({
      ...colors,
      slots: 4,
      up: [9, null, 0, 18],
      down: [20, null, 2],
    });
  });

  it("keeps the window while loading and has no heights for unusable ceilings", () => {
    expect(mirrorBarsModel({ ...network, loading: true })).toEqual({
      ...colors,
      slots: 4,
      up: [],
      down: [],
    });
    expect(mirrorBarsModel({ ...network, upMax: 0 }).up).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(mirrorBarsModel({ ...network, up: [], down: [] }).slots).toBe(1);
  });
});
