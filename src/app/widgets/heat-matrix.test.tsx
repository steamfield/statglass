import * as chartMath from "@core/chart-math";
import { MISSING } from "@core/format";
import { render } from "@testing-library/react";
import styles from "~/lib/motion/motion.module.css";
import {
  HeatMatrix,
  type HeatMatrixProps,
  HeatScaleLegend,
} from "./heat-matrix";

const props: HeatMatrixProps = {
  rows: [
    {
      id: "a",
      label: "Zone 01",
      title: "PMU tdie1",
      group: "x",
      now: 65,
      buckets: [20, 65, 110, 65],
    },
    { id: "b", label: "Zone 02", group: "x", now: 40, buckets: [40] },
    { id: "c", label: "Zone 03", group: "y", now: null, buckets: [50] },
  ],
  scale: { min: 20, max: 110 },
  formatNow: (v) => `${Math.round(v)}°`,
  bucketMs: 10_000,
  windowMs: 40_000,
  accent: "temp",
  ariaLabel: "SoC thermal zones",
};

const cellsOf = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>(".grid.gap-px > span"),
];

/** A cell's accent mix, "51%". */
const tint = (c: HTMLElement | undefined) => c?.style.getPropertyValue("--t");

describe("HeatMatrix", () => {
  it("shows a flat loading frame with labels, then reveals each row and restores gaps", () => {
    const data: HeatMatrixProps = {
      ...props,
      endMs: 30_000,
      gaps: [{ fromMs: 10_000, toMs: 20_000, label: "Asleep" }],
    };
    const { container, getByRole, getByText, rerender } = render(
      <HeatMatrix {...data} loading />
    );
    const root = getByRole("img");
    expect(root).toHaveClass("group");
    expect(root).toHaveAttribute("data-loading", "true");
    expect(container.querySelector("[role=note]")).toBeNull();
    const track = container.querySelector("[data-chart-loading]");
    expect(track).toBeInTheDocument();
    expect(track?.parentElement?.style.gridRow).toBe("1 / 4");
    const cells = cellsOf(container);
    expect(cells).toHaveLength(12);
    for (const cell of cells) {
      expect(cell.style.background).toBe("");
      expect(cell).toHaveClass(
        "group-data-loading:bg-none",
        "group-data-loading:bg-track"
      );
    }
    for (const label of ["Zone 01", "65°", "40°", "now"])
      expect(getByText(label)).toBeInTheDocument();
    const grids = [...container.querySelectorAll(".col-start-2.grid")];
    for (const grid of grids) expect(grid).not.toHaveClass(styles.reveal ?? "");
    rerender(<HeatMatrix {...data} loading={false} />);
    expect(root).not.toHaveAttribute("data-loading");
    expect(container.querySelector("[data-chart-loading]")).toBeNull();
    expect([...container.querySelectorAll(".col-start-2.grid")]).toEqual(grids);
    for (const grid of grids) expect(grid).toHaveClass(styles.reveal ?? "");
    expect(getByRole("note", { name: "Asleep" })).toBeInTheDocument();
    expect(tint(cellsOf(container)[0])).toBe("6%");
  });

  it("does not draw a loading mark without rows", () => {
    const { container } = render(<HeatMatrix {...props} rows={[]} loading />);
    expect(container.querySelector("[data-chart-loading]")).toBeNull();
  });

  it("renders only the changed Cell after loading ends, just as a chart mounted ready", () => {
    // Call-through instrumentation: heatmapAlpha runs once per Cell render.
    const renders = vi.spyOn(chartMath, "heatmapAlpha");
    try {
      const changed = props.rows.map((r, i) =>
        i === 0 ? { ...r, buckets: [20, 70, 110, 65] } : r
      );
      const ready = render(<HeatMatrix {...props} />);
      renders.mockClear();
      ready.rerender(<HeatMatrix {...props} rows={changed} />);
      const baseline = renders.mock.calls.length;
      expect(baseline).toBe(1);
      ready.unmount();
      const loaded = render(<HeatMatrix {...props} loading />);
      loaded.rerender(<HeatMatrix {...props} loading={false} />);
      renders.mockClear();
      loaded.rerender(<HeatMatrix {...props} rows={changed} loading={false} />);
      expect(renders.mock.calls).toHaveLength(baseline);
    } finally {
      renders.mockRestore();
    }
  });

  it("tints cells by their place on the scale, not from zero", () => {
    const { container } = render(<HeatMatrix {...props} />);
    const row = cellsOf(container).slice(0, 4);
    // 20 °C is the scale floor (6%), 65 °C its middle, 110 °C the top (95%).
    expect(row.map(tint)).toEqual(["6%", "51%", "95%", "51%"]);
  });

  it("formats the current value with formatNow and dashes a stale one", () => {
    const { getByText } = render(<HeatMatrix {...props} />);
    expect(getByText("65°")).toBeTruthy();
    expect(getByText("40°")).toBeTruthy();
    expect(getByText(MISSING)).toBeTruthy();
  });

  it("puts the row title on its label", () => {
    const { getByText } = render(<HeatMatrix {...props} />);
    expect(getByText("Zone 01").title).toBe("PMU tdie1");
  });

  it("breaks rows only where the group changes", () => {
    const { getByText } = render(<HeatMatrix {...props} />);
    const spaced = (label: string) =>
      getByText(label).parentElement?.className.includes("[&>*]:mt-2");
    expect(spaced("Zone 01")).toBe(false);
    expect(spaced("Zone 02")).toBe(false);
    expect(spaced("Zone 03")).toBe(true);
  });

  it("sizes the label column from labelWidth", () => {
    const { getByRole } = render(<HeatMatrix {...props} labelWidth={44} />);
    expect(
      getByRole("img", { name: "SoC thermal zones" }).style.gridTemplateColumns
    ).toBe("44px minmax(0, 1fr) 40px");
  });

  it("re-tints the closed cells when the scale changes", () => {
    const { container, rerender } = render(<HeatMatrix {...props} />);
    expect(tint(cellsOf(container)[0])).toBe("6%");
    rerender(<HeatMatrix {...props} scale={{ min: 0, max: 20 }} />);
    expect(tint(cellsOf(container)[0])).toBe("95%");
  });

  it("legend shows the given end labels", () => {
    const { getByText } = render(
      <HeatScaleLegend accent="temp" minLabel="68 °F" maxLabel="230 °F" />
    );
    expect(getByText("68 °F")).toBeTruthy();
    expect(getByText("230 °F")).toBeTruthy();
  });

  it("draws its end labels in the 4.5:1 muted text, not the faint tone", () => {
    const { getByText } = render(
      <HeatScaleLegend minLabel="0%" maxLabel="80%+" />
    );
    for (const label of ["0%", "80%+"]) {
      expect(getByText(label)).toHaveClass("text-muted-foreground");
      expect(getByText(label)).not.toHaveClass("text-fg-faint");
    }
  });
});
