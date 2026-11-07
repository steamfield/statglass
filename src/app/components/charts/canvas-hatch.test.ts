import { DENSE_HATCH_PX, type HatchContext, strokeHatch } from "./canvas-hatch";

function recorder() {
  const calls: string[] = [];
  const ctx: HatchContext = {
    strokeStyle: "",
    lineWidth: 0,
    save: () => calls.push("save"),
    clip: () => calls.push("clip"),
    beginPath: () => calls.push("beginPath"),
    moveTo: (x, y) => calls.push(`M${x},${y}`),
    lineTo: (x, y) => calls.push(`L${x},${y}`),
    stroke: () => calls.push("stroke"),
    restore: () => calls.push("restore"),
  };
  return { ctx, calls };
}

describe("strokeHatch", () => {
  it("strokes 1 px diagonals at the dense pitch, clipped to the cell", () => {
    const { ctx, calls } = recorder();
    strokeHatch(ctx, { x: 10, y: 20, width: 8, height: 4 }, "grey", 4);
    expect(ctx.strokeStyle).toBe("grey");
    expect(ctx.lineWidth).toBe(1);
    expect(calls).toEqual([
      "save",
      "clip",
      "beginPath",
      // k = -4, 0, 4: each line runs from the bottom edge up and right.
      "M6,24",
      "L10,20",
      "M10,24",
      "L14,20",
      "M14,24",
      "L18,20",
      "stroke",
      "restore",
    ]);
  });

  it("defaults to the 7 px pitch, wider than the dense variant", () => {
    const { ctx, calls } = recorder();
    strokeHatch(ctx, { x: 0, y: 0, width: 14, height: 7 }, "grey");
    const starts = calls.filter((c) => c.startsWith("M"));
    expect(starts).toEqual(["M-7,7", "M0,7", "M7,7"]);
    expect(DENSE_HATCH_PX).toBeLessThan(7);
  });
});
