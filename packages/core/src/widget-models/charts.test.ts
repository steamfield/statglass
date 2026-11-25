import { annotationsModel } from "./chart-annotation";
import { POPOVER_CPU_STREAM } from "./fixtures/charts";
import { gapBandsModel } from "./gap-band";
import { type StreamAreaModel, streamAreaModel } from "./stream-area";

// Paths captured from the desktop gallery before extracting the model.
const CPU_LINE =
  "M0,33L16.949,30.625L33.898,27.75L50.847,29.75L67.797,28L84.746,31.75L101.695,33.5L118.644,33" +
  ".5L135.593,33.375L152.542,30.875L169.492,26.625L186.441,26.125L203.39,29.75L220.339,32.375L2" +
  "37.288,33.75L254.237,31.375L271.186,32.125L288.136,35.5L305.085,30.375L322.034,31.5L338.983," +
  "34.625L355.932,34L372.881,28.875L389.831,27.375L406.78,30.125L423.729,28.5L440.678,28.875L45" +
  "7.627,30.875L474.576,34.25L491.525,33L508.475,31.625L525.424,28.25L542.373,30L559.322,32L576" +
  ".271,29.75L593.22,28.25L610.169,31.25L627.119,28.25L644.068,24.125L661.017,22.125L677.966,25" +
  ".75L694.915,22.625L711.864,22.75L728.814,21.5L745.763,25.125L762.712,27L779.661,30.375L796.6" +
  "1,30.625L813.559,31.5L830.508,33.75L847.458,29.75L864.407,30.5L881.356,32.875L898.305,33.125" +
  "L915.254,29.5L932.203,26.375L949.153,27.375L966.102,27.75L983.051,27.5L1000,29.375";
const CPU_BASELINE =
  "L1000,52L983.051,52L966.102,52L949.153,52L932.203,52L915.254,52L898.305,52L881.356,52L864.40" +
  "7,52L847.458,52L830.508,52L813.559,52L796.61,52L779.661,52L762.712,52L745.763,52L728.814,52L" +
  "711.864,52L694.915,52L677.966,52L661.017,52L644.068,52L627.119,52L610.169,52L593.22,52L576.2" +
  "71,52L559.322,52L542.373,52L525.424,52L508.475,52L491.525,52L474.576,52L457.627,52L440.678,5" +
  "2L423.729,52L406.78,52L389.831,52L372.881,52L355.932,52L338.983,52L322.034,52L305.085,52L288" +
  ".136,52L271.186,52L254.237,52L237.288,52L220.339,52L203.39,52L186.441,52L169.492,52L152.542," +
  "52L135.593,52L118.644,52L101.695,52L84.746,52L67.797,52L50.847,52L33.898,52L16.949,52L0,52Z";

describe("streamAreaModel", () => {
  it("preserves the popover CPU geometry and describes its colors as tokens", () => {
    expect(streamAreaModel(POPOVER_CPU_STREAM, { widthPx: 322 })).toEqual({
      height: 52,
      slots: 60,
      windowMs: 59_000,
      dashOffset: 2.203390121459961,
      series: [
        {
          key: "cpu.total",
          linePath: CPU_LINE,
          areaPath: CPU_LINE + CPU_BASELINE,
          edges: [],
          filled: true,
          opacity: 1,
          stroke: { kind: "accent", step: 1, ink: true },
          fill: { kind: "accent", step: 1, ink: false },
          dash: null,
          weight: 1.5,
        },
      ],
      gaps: [],
      annotations: [],
      ceilingLabel: "40%",
      windowLabel: "60s",
    });
  });

  it("breaks both paths at a null and puts dots only on edges facing the break", () => {
    const model = streamAreaModel(
      {
        ...POPOVER_CPU_STREAM,
        yMax: 50,
        series: [{ key: "cpu", step: 1, values: [5, 10, null, 15, 20] }],
      },
      { widthPx: 0 }
    );
    expect(model.series[0]).toMatchObject({
      linePath: "M0,46L250,41M750,36L1000,31",
      areaPath: "M0,46L250,41L250,52L0,52ZM750,36L1000,31L1000,52L750,52Z",
      edges: [
        { xFrac: 0.25, y: expect.closeTo(41) },
        { xFrac: 0.75, y: expect.closeTo(36) },
      ],
    });
    expect(model.dashOffset).toBe(0);
  });

  it("right-aligns short series and draws a lone point as one dot", () => {
    const model = streamAreaModel(
      {
        ...POPOVER_CPU_STREAM,
        tEndMs: 3_000,
        yMax: 0,
        series: [
          { key: "missing", step: 1, values: [null, null, null] },
          { key: "short", step: 2, values: [-0.5, 2], fill: false, dash: true },
          { key: "point", step: 3, values: [0.5] },
        ],
      },
      { widthPx: 12 }
    );
    expect(model.dashOffset).toBe(3);
    expect(model.series[0]).toMatchObject({
      linePath: "",
      areaPath: "",
      edges: [],
    });
    expect(model.series[1]).toMatchObject({
      linePath: "M500,51L1000,1",
      areaPath: "",
      edges: [],
      dash: [3, 2],
    });
    expect(model.series[2]).toMatchObject({
      linePath: "",
      areaPath: "",
      edges: [{ xFrac: 1, y: 26 }],
    });
  });

  it("keeps the layout while loading and leaves out all data marks", () => {
    const { tEndMs } = POPOVER_CPU_STREAM;
    const model = streamAreaModel(
      {
        ...POPOVER_CPU_STREAM,
        loading: true,
        gaps: [{ fromMs: tEndMs - 10_000, toMs: tEndMs, label: "Asleep" }],
        annotations: [{ tsMs: tEndMs, label: "Spike" }],
      },
      { widthPx: 322 }
    );
    expect(model).toMatchObject({
      slots: 60,
      windowMs: 59_000,
      ceilingLabel: "40%",
      series: [],
      gaps: [],
      annotations: [],
    });
  });
});

describe("gapBandsModel", () => {
  it("clips both sides, keeps the pause state and omits spans that only touch the window", () => {
    expect(
      gapBandsModel(
        [
          { fromMs: -10, toMs: 0, label: "Before" },
          { fromMs: -10, toMs: 25, label: "Asleep" },
          {
            fromMs: 75,
            toMs: 110,
            label: "Paused",
            reason: "paused",
            showCaption: false,
          },
          { fromMs: 100, toMs: 110, label: "After" },
        ],
        0,
        100
      )
    ).toEqual([
      {
        key: "-10:25:Asleep",
        leftFrac: 0,
        widthFrac: 0.25,
        label: "Asleep",
        paused: false,
        fromMs: -10,
        toMs: 25,
        showCaption: true,
      },
      {
        key: "75:110:Paused",
        leftFrac: 0.75,
        widthFrac: 0.25,
        label: "Paused",
        paused: true,
        fromMs: 75,
        toMs: 110,
        showCaption: false,
      },
    ]);
  });
});

describe("annotationsModel", () => {
  it("reserves more width for larger captions through the chart model contract", () => {
    const model: StreamAreaModel = streamAreaModel(
      {
        ...POPOVER_CPU_STREAM,
        gaps: [
          {
            fromMs: POPOVER_CPU_STREAM.tEndMs - 1_000,
            toMs: POPOVER_CPU_STREAM.tEndMs,
            label: "Asleep",
          },
        ],
        annotations: [
          { tsMs: POPOVER_CPU_STREAM.tEndMs - 20_000, label: "Spike" },
        ],
      },
      { widthPx: 322, annotationScale: 2 }
    );
    expect(model.annotations[0]?.fitPx).toBe(76);
    expect(model.gaps[0]?.showCaption).toBe(true);
  });

  it("drops out-of-window markers and stacks then merges colliding labels", () => {
    expect(
      annotationsModel(
        [
          { tsMs: 90, label: "Right", variant: "pill" },
          { tsMs: 11, label: "Second row" },
          { tsMs: 12, label: "Merged" },
          { tsMs: -1, label: "Before" },
          { tsMs: 10, label: "First row" },
          { tsMs: 101, label: "After" },
        ],
        100,
        100,
        500
      )
    ).toEqual([
      {
        key: "10-First row",
        tMs: 10,
        xFrac: 0.1,
        row: 0,
        more: 0,
        label: "First row",
        tone: "fg-subtle",
        tsMs: 10,
        variant: "marker",
        side: "start",
        leftPx: 50,
        fitPx: 70,
      },
      {
        key: "11-Second row",
        tMs: 11,
        xFrac: 0.11,
        row: 1,
        more: 1,
        label: "Second row +1",
        tone: "fg-subtle",
        tsMs: 11,
        variant: "marker",
        side: "start",
        leftPx: 55,
        fitPx: 94,
      },
      {
        key: "90-Right",
        tMs: 90,
        xFrac: 0.9,
        row: 0,
        more: 0,
        label: "Right",
        tone: "fg-subtle",
        tsMs: 90,
        variant: "pill",
        side: "end",
        leftPx: 404,
        fitPx: 46,
      },
    ]);
  });
});
