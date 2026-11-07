import { DENSE_HATCH_PX, type HatchContext, strokeHatch } from "./canvas-hatch";

function recorder() {
  const calls: string[] = [];
  const starts: [number, number][] = [];
  const ctx: HatchContext = {
    strokeStyle: "",
    lineWidth: 0,
    save: () => calls.push("save"),
    clip: () => calls.push("clip"),
    beginPath: () => calls.push("beginPath"),
    moveTo: (x, y) => {
      calls.push("M");
      starts.push([x, y]);
    },
    lineTo: (x, y) => calls.push(`L${x - (starts.at(-1)?.[0] ?? 0)},${y}`),
    stroke: () => calls.push("stroke"),
    restore: () => calls.push("restore"),
  };
  return { ctx, calls, starts };
}

/** Distance between neighbouring stripes, measured across them. */
function pitches(starts: [number, number][]): number[] {
  return starts
    .slice(1)
    .map(([x], i) => (x - (starts[i]?.[0] ?? 0)) / Math.SQRT2);
}

describe("strokeHatch", () => {
  it("strokes 1 px diagonals at the dense pitch, clipped to the cell", () => {
    const { ctx, calls, starts } = recorder();
    strokeHatch(ctx, { x: 10, y: 20, width: 8, height: 4 }, "grey", 4);
    expect(ctx.strokeStyle).toBe("grey");
    expect(ctx.lineWidth).toBe(1);
    // Each line runs from the bottom edge up and right at 45°.
    expect(calls).toEqual([
      "save",
      "clip",
      "beginPath",
      "M",
      "L4,20",
      "M",
      "L4,20",
      "M",
      "L4,20",
      "stroke",
      "restore",
    ]);
    expect(starts[0]).toEqual([6, 24]);
    expect(starts.every(([, y]) => y === 24)).toBe(true);
    // 4 px apart across the stripes, like `bg-gap-hatch-dense`.
    for (const p of pitches(starts)) expect(p).toBeCloseTo(4, 9);
  });

  it("defaults to the 7 px pitch, wider than the dense variant", () => {
    const { ctx, starts } = recorder();
    strokeHatch(ctx, { x: 0, y: 0, width: 28, height: 7 }, "grey");
    expect(pitches(starts).length).toBeGreaterThan(1);
    for (const p of pitches(starts)) expect(p).toBeCloseTo(7, 9);
    expect(DENSE_HATCH_PX).toBeLessThan(7);
  });
});
