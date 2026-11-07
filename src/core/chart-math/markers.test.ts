import { layoutMarkers } from "@core/chart-math";

const MIN = 60_000;

interface M {
  tMs: number;
  label: string;
  end?: boolean;
}

const m = (tMs: number, label: string): M => ({ tMs, label });
const ev = (tMs: number, label: string): M => ({ tMs, label, end: true });

const layout = (markers: M[], extra: { hangPx?: number } = {}) =>
  layoutMarkers(markers, {
    fromMs: 0,
    toMs: 100 * MIN,
    widthPx: 1000,
    measure: () => 100,
    side: (x) => (x.end ? "end" : "start"),
    ...extra,
  });

describe("layoutMarkers", () => {
  it("never overlaps pills on a row", () => {
    const placed = layout([m(0, "a"), m(10 * MIN, "b"), m(11 * MIN, "c")]);
    for (const row of [0, 1]) {
      const onRow = placed.filter((p) => p.row === row);
      for (let i = 1; i < onRow.length; i++) {
        const prev = onRow[i - 1] as (typeof onRow)[number];
        expect(
          (onRow[i] as (typeof onRow)[number]).leftPx
        ).toBeGreaterThanOrEqual(prev.leftPx + 100);
      }
    }
    expect(placed.map((p) => p.row)).toEqual([0, 1, 0].slice(0, placed.length));
  });

  it("moves a colliding pill to the second row, then merges into +N", () => {
    const placed = layout([
      m(0, "a"),
      m(MIN, "b"),
      m(2 * MIN, "c"),
      m(3 * MIN, "d"),
    ]);
    expect(placed.map((p) => [p.label, p.row, p.more])).toEqual([
      ["a", 0, 0],
      ["b", 1, 2],
    ]);
  });

  it("ends an end-side pill at its time, pulled inside at the left edge", () => {
    const placed = layout([
      ev(5 * MIN, "early"),
      ev(50 * MIN, "e1"),
      ev(55 * MIN, "e2"),
    ]);
    expect(placed.map((p) => [p.label, p.leftPx, p.row])).toEqual([
      ["early", 0, 0],
      // The dot sits on the time: the pill ends 4 px past x = 500.
      ["e1", 404, 0],
      ["e2", 454, 1],
    ]);
  });

  it("anchors exactly on the time with no hang", () => {
    const placed = layout([m(20 * MIN, "start"), ev(80 * MIN, "end")], {
      hangPx: 0,
    });
    expect(placed.map((p) => p.leftPx)).toEqual([200, 700]);
  });

  it("merges a crowded marker into the nearest pill, not the last placed", () => {
    const placed = layout([
      m(0, "a"),
      m(MIN, "b"),
      m(50 * MIN, "far"),
      m(2 * MIN, "c"),
    ]);
    expect(placed.map((p) => [p.label, p.more])).toEqual([
      ["a", 0],
      ["b", 1],
      ["far", 0],
    ]);
  });

  it("pulls a pill at the right edge back inside", () => {
    const [p] = layout([m(100 * MIN, "end")]);
    expect(p?.leftPx).toBe(900);
  });
});
