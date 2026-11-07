import { render } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import { StreamArea, type StreamAreaProps } from "./stream-area";

const props: StreamAreaProps = {
  series: [
    { key: "total", values: [10, 12, 14, 13, 18], step: 1 },
    { key: "system", values: [3, 4, 4, 5, 5.6], step: 2 },
  ],
  tEndMs: 1_760_000_000_000,
  intervalMs: 1000,
  yMax: 40,
  accent: "cpu",
  height: 52,
  ariaLabel: "CPU, last 60 seconds",
  ceilingLabel: "40%",
  windowLabel: "60s",
  gridlines: [20],
};

/** Runs `fn` with every ResizeObserver reporting a box `width` px wide. */
function withWidth(width: number, fn: () => void) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    fn();
  } finally {
    globalThis.ResizeObserver = original;
  }
}

function moveCount(d: string | null | undefined): number {
  return (d ?? "").match(/M/g)?.length ?? 0;
}

describe("StreamArea", () => {
  it("renders the same after a JSON round trip", () => {
    expectJsonRoundTrip(StreamArea, props);
  });

  it("places gap bands on its own time axis", () => {
    // Five values 1 s apart end at tEndMs: the axis is the last 4 s.
    const { getByRole, rerender, queryByRole } = render(
      <StreamArea
        {...props}
        gaps={[
          {
            fromMs: props.tEndMs - 3_000,
            toMs: props.tEndMs - 2_000,
            label: "Asleep 11:02–11:31 · not interpolated",
          },
        ]}
      />
    );
    const band = getByRole("note", {
      name: "Asleep 11:02–11:31 · not interpolated",
    });
    expect(band.style.left).toBe("25.00%");
    expect(band.style.width).toBe("25.00%");
    rerender(
      <StreamArea
        {...props}
        gaps={[{ fromMs: 0, toMs: props.tEndMs - 10_000, label: "Paused" }]}
      />
    );
    expect(queryByRole("note")).toBeNull();
  });

  it("is an img named by its aria-label", () => {
    const { getByRole } = render(<StreamArea {...props} />);
    expect(getByRole("img", { name: "CPU, last 60 seconds" })).toBeTruthy();
  });

  it("breaks the line at a null instead of bridging it", () => {
    const { container } = render(
      <StreamArea
        {...props}
        series={[{ key: "total", values: [10, 12, null, 13, 18], step: 1 }]}
      />
    );
    const d = container.querySelector("[data-line]")?.getAttribute("d");
    expect(moveCount(d)).toBe(2);
    // A hollow dot on each edge that borders the gap.
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(2);
  });

  it("draws one segment and no edge dots when nothing is missing", () => {
    const { container } = render(<StreamArea {...props} />);
    const d = container.querySelector("[data-line]")?.getAttribute("d");
    expect(moveCount(d)).toBe(1);
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(0);
  });

  it("leaves no stale edge dots when isolated points fill back in", () => {
    // Every other slot missing: each value is a one-point run with gaps on
    // both sides. The next tick has no gaps, so no dot may remain.
    const { container, rerender } = render(
      <StreamArea
        {...props}
        series={[
          { key: "total", values: [10, null, 12, null, 14, null], step: 1 },
        ]}
      />
    );
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(3);
    rerender(
      <StreamArea
        {...props}
        series={[{ key: "total", values: [10, 11, 12, 13, 14, 15], step: 1 }]}
      />
    );
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(0);
  });

  it("draws no line for a one-point run, only its edge dot", () => {
    const { container } = render(
      <StreamArea
        {...props}
        series={[
          { key: "total", values: [10, null, 12, null, 13, 18], step: 1 },
        ]}
      />
    );
    const d = container.querySelector("[data-line]")?.getAttribute("d");
    // Only the [13, 18] run is a segment; 10 and 12 would be round-capped dots.
    expect(moveCount(d)).toBe(1);
    expect(d).not.toMatch(/Z/);
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(3);
  });

  it("draws a bare line with no area and no edge dots, as for app lines", () => {
    const { container } = render(
      <StreamArea
        {...props}
        series={[
          {
            key: "app",
            values: [1, 2, null, 3, 4],
            step: 3,
            fill: false,
            edges: false,
            weight: 1,
            opacity: 0.3,
          },
        ]}
      />
    );
    const g = container.querySelector('[data-series="app"]');
    expect(g?.querySelector("[data-area]")).toBeNull();
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(0);
    expect(g?.getAttribute("opacity")).toBe("0.3");
    expect(g?.querySelector("[data-line]")?.getAttribute("stroke-width")).toBe(
      "1"
    );
  });

  it("keeps gap-edge dots on a bare line unless edges is false", () => {
    const bare = (edges: boolean) => (
      <StreamArea
        {...props}
        series={[
          {
            key: "system",
            values: [1, null, 2, 3],
            step: 1,
            fill: false,
            edges,
          },
        ]}
      />
    );
    const { container, rerender } = render(bare(true));
    expect(container.querySelector("[data-area]")).toBeNull();
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(2);
    rerender(bare(false));
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(0);
  });

  it("dashes a line with dash and leaves others solid", () => {
    const { container } = render(
      <StreamArea
        {...props}
        series={[
          { key: "a", values: [1, 2, 3], step: 2 },
          { key: "b", values: [3, 2, 1], step: 2, dash: true },
        ]}
      />
    );
    const dash = (key: string) =>
      container
        .querySelector(`[data-series="${key}"] [data-line]`)
        ?.getAttribute("stroke-dasharray");
    expect(dash("a")).toBeNull();
    expect(dash("b")).toBe("3 2");
  });

  it("keeps the area, 1.5 px weight and full opacity by default", () => {
    const { container } = render(<StreamArea {...props} />);
    const g = container.querySelector('[data-series="total"]');
    expect(g?.querySelector("[data-area]")).not.toBeNull();
    expect(g?.getAttribute("opacity")).toBe("1");
    expect(g?.querySelector("[data-line]")?.getAttribute("stroke-width")).toBe(
      "1.5"
    );
  });

  it("places annotations inside the window and drops ones outside it", () => {
    // Five values 1 s apart: the window is the last 4 s, 1000 px wide.
    withWidth(1000, () => {
      const { getByText, queryByText, rerender } = render(
        <StreamArea
          {...props}
          annotations={[{ tsMs: props.tEndMs - 2_000, label: "ANE 1.4 W" }]}
        />
      );
      expect(getByText("ANE 1.4 W").parentElement?.style.left).toBe("500px");
      rerender(
        <StreamArea
          {...props}
          annotations={[{ tsMs: props.tEndMs - 60_000, label: "old" }]}
        />
      );
      expect(queryByText("old")).toBeNull();
    });
  });

  it("moves a colliding label to the second row, then merges it as +N", () => {
    // 100 px apart on a 1000 px plot; each label is about 70 px wide.
    withWidth(1000, () => {
      const { getByText, queryByText } = render(
        <StreamArea
          {...props}
          annotations={[
            { tsMs: props.tEndMs - 2_600, label: "Spike one" },
            { tsMs: props.tEndMs - 2_500, label: "Spike two" },
            { tsMs: props.tEndMs - 2_400, label: "Spike six" },
          ]}
        />
      );
      expect(getByText("Spike one").parentElement?.style.top).toBe("12px");
      // The third has no room on either row: it merges into the nearest.
      expect(getByText("Spike two +1").parentElement?.style.top).toBe("34px");
      expect(queryByText(/Spike six/)).toBeNull();
    });
  });

  it("moves the dash pattern with the data as the window scrolls", () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb(
          [{ contentRect: { width: 401 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      // 401 px over 3 values: 200.5 px per slot, so each tick moves the
      // pattern 0.5 px along its 5 px period.
      const dashed = (tEndMs: number) => (
        <StreamArea
          {...props}
          tEndMs={tEndMs}
          series={[{ key: "b", values: [3, 2, 1], step: 2, dash: true }]}
        />
      );
      const { container, rerender } = render(dashed(1_000));
      const offset = () =>
        container
          .querySelector('[data-series="b"] [data-line]')
          ?.getAttribute("stroke-dashoffset");
      expect(offset()).toBe("0.50");
      rerender(dashed(2_000));
      expect(offset()).toBe("1.00");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("anchors an annotation past the middle by its right edge", () => {
    withWidth(1000, () => {
      const { getByText } = render(
        <StreamArea
          {...props}
          annotations={[{ tsMs: props.tEndMs - 1_000, label: "late" }]}
        />
      );
      const label = getByText("late");
      expect(label.parentElement?.style.right).toBe("250px");
      expect(label.parentElement?.style.left).toBe("");
      expect(label.className).toContain("flex-row-reverse");
    });
  });
});

describe("StreamArea one-bucket runs", () => {
  it("draws the dot alone when a series' only run is one bucket", () => {
    const { container } = render(
      <StreamArea
        {...props}
        series={[{ key: "total", values: [null, null, 12, null], step: 1 }]}
      />
    );
    expect(container.querySelector("[data-line]")?.getAttribute("d")).toBe("");
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(1);
  });
});
