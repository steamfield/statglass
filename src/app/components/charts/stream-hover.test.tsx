import { fireEvent, render, screen } from "@testing-library/react";
import { CrosshairLine } from "./crosshair-line";
import {
  type ReadoutRow,
  StreamHover,
  type StreamHoverProps,
} from "./stream-hover";

const T_END = Date.UTC(2026, 10, 26, 12, 0, 0);
const TOTAL: ReadoutRow = {
  key: "cpu.total",
  label: "Total",
  step: 1,
  values: [10, 20, null, 40, 50],
  format: (v) => `${v}%`,
};
const BASE: StreamHoverProps = {
  slots: 5,
  tEndMs: T_END,
  intervalMs: 10_000,
  yMax: 100,
  height: 100,
  rows: [
    TOTAL,
    {
      key: "cpu.system",
      label: "System",
      step: 2,
      // Shorter than the plot: right-aligned to its last slots.
      values: [null, null, 7],
      format: (v) => `${v}%`,
    },
  ],
  dots: [{ key: "cpu.total", step: 1, values: [10, 20, null, 40, 50] }],
  gaps: [
    {
      fromMs: T_END - 25_000,
      toMs: T_END - 15_000,
      label: "Asleep",
      reason: "sleep",
      closedDurationMs: 10_000,
      showCaption: true,
      module: null,
    },
  ],
  accent: "cpu",
  dateLabels: false,
};

function Plot(props: Partial<StreamHoverProps>) {
  return (
    <div data-testid="plot" className="relative">
      <CrosshairLine paint height={100} />
      <StreamHover {...BASE} {...props} />
    </div>
  );
}

function setup() {
  const r = render(<Plot />);
  const plot = screen.getByTestId("plot");
  plot.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
  // 400 px over 5 slots: slot i sits at x = i * 100.
  const hover = (x: number) => fireEvent.pointerMove(plot, { clientX: x });
  const tip = () => screen.getByRole("tooltip", { hidden: true });
  const dot = () =>
    r.container.querySelector<HTMLElement>('[data-readout-dot="0"]');
  return { r, plot, hover, tip, dot };
}

describe("StreamHover", () => {
  it("reads every row at the hovered point, right-aligned to the plot", () => {
    const { hover, tip, dot } = setup();
    expect(tip()).not.toBeVisible();
    hover(390);
    expect(tip()).toBeVisible();
    expect(tip()).toHaveTextContent("Total50%");
    expect(tip()).toHaveTextContent("System7%");
    expect(tip()).toHaveTextContent("10 s avg");
    expect(dot()).toBeVisible();
    expect(dot()?.style.top).toBe("50px");
  });

  it("shows a missing row as a dash, never 0, and hides its dot", () => {
    const { hover, tip } = setup();
    hover(310);
    expect(tip()).toHaveTextContent("Total40%");
    expect(tip()).toHaveTextContent("System—");
  });

  it("explains a point where every row is missing with the gap's label", () => {
    const { hover, tip, dot } = setup();
    hover(200);
    expect(tip()).toHaveTextContent("Asleep");
    expect(tip().querySelector('[data-tip="rows"]')).not.toBeVisible();
    expect(dot()).not.toBeVisible();
  });

  it("repaints the point under a resting cursor when the values move", () => {
    const { r, hover, tip } = setup();
    hover(390);
    expect(tip()).toHaveTextContent("Total50%");
    r.rerender(<Plot rows={[{ ...TOTAL, values: [20, null, 40, 50, 60] }]} />);
    expect(tip()).toHaveTextContent("Total60%");
  });

  it("hides the tooltip, crosshair and dots when the pointer leaves", () => {
    const { r, plot, hover, tip, dot } = setup();
    hover(390);
    fireEvent.pointerLeave(plot);
    expect(tip()).not.toBeVisible();
    expect(dot()).not.toBeVisible();
    expect(
      r.container.querySelector<HTMLElement>('[data-crosshair="paint"]')
    ).not.toBeVisible();
  });
});
