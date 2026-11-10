import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { LiveMirrorChart } from "~/components/live-mirror-chart";
import { BrushProvider } from "~/stores/brush-store";
import { ChartRangeProvider } from "~/stores/chart-range";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { COMPACT_PLOT_INSET, PLOT_INSET } from "./layout";
import {
  MirrorChart,
  type MirrorChartProps,
  mirrorSubject,
  paintMirrorCrosshairs,
} from "./mirror-chart";

const plot: MirrorChartProps = {
  up: [1, 2, null, 4],
  down: [6, 3, null, 1],
  firstMs: 1_700_000_000_000,
  bucketMs: 10_000,
  windowMs: 40_000,
  fixedEndMs: null,
  subject: "Disk I/O",
  upLabel: "Read",
  downLabel: "Write",
  span: "last 40 seconds",
  format: (v) => `${v} MB/s`,
  minCeiling: 1,
  accent: "disk",
  upHeight: 48,
  downHeight: 48,
  brush: false,
  dateLabels: false,
};

describe("mirrorSubject", () => {
  it("names the subject and both directions in one wording", () => {
    expect(
      mirrorSubject({
        subject: "Network",
        upLabel: "Upload",
        downLabel: "Download",
      })
    ).toBe("Network: upload above the line, download below");
  });
});

describe("MirrorChart", () => {
  it("labels each side's ceiling and ends a live axis at now", () => {
    renderWithProviders(<MirrorChart {...plot} />);
    expect(screen.getByText("4 MB/s")).toBeVisible();
    expect(screen.getByText("6 MB/s")).toBeVisible();
    expect(screen.getByText("now")).toBeVisible();
  });

  it("keeps five ticks, the full inset and hover by default", () => {
    const { container } = renderWithProviders(<MirrorChart {...plot} />);
    const ticks = screen.getByText("now").parentElement;
    expect(ticks?.children).toHaveLength(5);
    expect(ticks).toHaveStyle({ paddingLeft: `${PLOT_INSET}px` });
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
    expect(container.querySelector('[data-crosshair="paint"]')).not.toBeNull();
  });

  it("omits the hover readout and crosshair when hover is disabled", () => {
    const initial = renderWithProviders(<MirrorChart {...plot} />);
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
    initial.unmount();
    const { container } = renderWithProviders(
      <MirrorChart {...plot} hover={false} />
    );
    fireEvent.pointerMove(screen.getByRole("img"), { clientX: 150 });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(container.querySelector("[data-crosshair]")).toBeNull();
  });

  it.each([null, plot.firstMs + 40_000])(
    "draws three ticks for end %s",
    (fixedEndMs) => {
      const { container } = renderWithProviders(
        <MirrorChart {...plot} fixedEndMs={fixedEndMs} ticks={3} />
      );
      const ticks = container.firstElementChild?.lastElementChild;
      expect(ticks?.children).toHaveLength(3);
      if (fixedEndMs === null) expect(ticks).toHaveTextContent("now");
      else expect(ticks).not.toHaveTextContent("now");
    }
  );

  it("aligns compact labels, brush, gaps, ticks and hover to the same inset", () => {
    const { container } = renderWithProviders(
      <BrushProvider>
        <MirrorChart
          {...plot}
          brush
          inset={COMPACT_PLOT_INSET}
          gaps={[
            {
              fromMs: plot.firstMs,
              toMs: plot.firstMs + 10_000,
              label: "Asleep",
            },
          ]}
        />
      </BrushProvider>
    );
    const image = screen.getByRole("img");
    const plotBox = image.parentElement?.parentElement;
    if (!plotBox) throw new Error("Missing plot box");
    expect(plotBox).toHaveStyle({ paddingLeft: `${COMPACT_PLOT_INSET}px` });
    expect(screen.getByText("↑ Read").parentElement).toHaveStyle({
      width: `${COMPACT_PLOT_INSET - 8}px`,
    });
    expect(screen.getByRole("slider")).toHaveStyle({
      left: `${COMPACT_PLOT_INSET}px`,
    });
    expect(
      screen.getByRole("note", { name: "Asleep" }).parentElement
    ).toHaveStyle({ left: `${COMPACT_PLOT_INSET}px` });
    expect(screen.getByText("now").parentElement).toHaveStyle({
      paddingLeft: `${COMPACT_PLOT_INSET}px`,
    });
    const bars = image.parentElement;
    if (!bars) throw new Error("Missing bars");
    bars.getBoundingClientRect = () => new DOMRect(0, 0, 200, 97);
    fireEvent.pointerMove(plotBox, { clientX: 75 });
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(container.querySelector('[data-crosshair="paint"]')).toHaveStyle({
      left: `calc(${COMPACT_PLOT_INSET}px + (100% - ${COMPACT_PLOT_INSET}px) * 0.375)`,
    });
  });

  it("names actual times once the range's end is fixed", () => {
    renderWithProviders(
      <MirrorChart {...plot} fixedEndMs={plot.firstMs + 40_000} />
    );
    expect(screen.queryByText("now")).toBeNull();
  });

  it("starts a live axis at the window when the bars start off a bucket edge", () => {
    // An hour of minute bars from an unaligned start: the first bar is
    // floored, so 61 bars span up to a bucket more than the window.
    const minute = 60_000;
    renderWithProviders(
      <MirrorChart
        {...plot}
        up={Array.from({ length: 61 }, () => 1)}
        down={Array.from({ length: 61 }, () => 1)}
        bucketMs={minute}
        windowMs={60 * minute}
        span="last hour"
      />
    );
    expect(screen.getByText("−60m")).toBeVisible();
    expect(screen.queryByText("−61m")).toBeNull();
    expect(screen.getByText("now")).toBeVisible();
  });

  it("keeps a gap caption inside the band, clear of the tick row", () => {
    renderWithProviders(
      <MirrorChart
        {...plot}
        gaps={[
          {
            fromMs: plot.firstMs + 10_000,
            toMs: plot.firstMs + 30_000,
            label: "Asleep 11:02–11:31 · not interpolated",
          },
        ]}
      />
    );
    const band = screen.getByRole("note", {
      name: "Asleep 11:02–11:31 · not interpolated",
    });
    expect(band).toHaveClass("items-center");
    expect(
      screen.getByText("Asleep 11:02–11:31 · not interpolated")
    ).not.toHaveClass("translate-y-1/2");
  });

  it("veils along bar edges, never through a 30 s bar", () => {
    // 10 s inside the second of four 30 s bars.
    const selected = {
      fromMs: plot.firstMs + 40_000,
      toMs: plot.firstMs + 50_000,
    };
    renderWithProviders(
      <BrushProvider initial={selected}>
        <MirrorChart {...plot} bucketMs={30_000} windowMs={120_000} brush />
      </BrushProvider>
    );
    const veil = screen.getByTestId("stream-veil");
    expect(veil).toHaveStyle({ width: "25.000%" });
    expect(veil.nextElementSibling).toHaveStyle({ left: "50.000%" });
  });

  it("paints caller-managed crosshairs at the compact plot's bar centers", () => {
    const { container } = renderWithProviders(
      <>
        <MirrorChart
          {...plot}
          brush
          onHoverTime={vi.fn()}
          inset={COMPACT_PLOT_INSET}
          axis={false}
        />
        <MirrorChart
          {...plot}
          brush
          onHoverTime={vi.fn()}
          inset={COMPACT_PLOT_INSET}
        />
      </>
    );
    paintMirrorCrosshairs(container, 1, 4, COMPACT_PLOT_INSET);
    const lines = container.querySelectorAll('[data-crosshair="paint"]');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toBeVisible();
      expect(line).toHaveStyle({
        left: `calc(${COMPACT_PLOT_INSET}px + (100% - ${COMPACT_PLOT_INSET}px) * 0.375)`,
      });
    }
  });

  it("paints one crosshair across sibling plots at the hovered bar", () => {
    const { container } = renderWithProviders(
      <>
        <MirrorChart {...plot} brush onHoverTime={vi.fn()} axis={false} />
        <MirrorChart
          {...plot}
          subject="Operations/s"
          brush
          onHoverTime={vi.fn()}
        />
      </>
    );
    const lines = () => [
      ...container.querySelectorAll<HTMLElement>('[data-crosshair="paint"]'),
    ];
    expect(lines()).toHaveLength(2);
    expect(lines().every((el) => el.hidden)).toBe(true);
    paintMirrorCrosshairs(container, 1, 4);
    expect(lines().map((el) => el.hidden)).toEqual([false, false]);
    expect(new Set(lines().map((el) => el.style.left)).size).toBe(1);
    paintMirrorCrosshairs(container, null, 4);
    expect(lines().every((el) => el.hidden)).toBe(true);
    // The owner's readout replaces the chart's own tooltip.
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("LiveMirrorChart", () => {
  it("forwards hover, tick count and inset to its plot", async () => {
    const { container } = renderWithProviders(
      <ChartRangeProvider>
        <LiveMirrorChart
          subject="Network"
          upKey="net.tx_total"
          downKey="net.rx_total"
          upLabel="Upload"
          downLabel="Download"
          windowMs={60_000}
          accent="net"
          format={String}
          minCeiling={1}
          hover={false}
          ticks={3}
          inset={COMPACT_PLOT_INSET}
        />
      </ChartRangeProvider>
    );
    await screen.findByRole("img", { name: /^Network: upload above the line/ });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(container.querySelector("[data-crosshair]")).toBeNull();
    const ticks = screen.getByText("now").parentElement;
    expect(ticks?.children).toHaveLength(3);
    expect(ticks).toHaveStyle({ paddingLeft: `${COMPACT_PLOT_INSET}px` });
  });

  it("commits once per pushed frame", async () => {
    let store: HostStore | undefined;
    function Capture() {
      store = useHostStore();
      return null;
    }
    const commits: number[] = [];
    const { transport } = renderWithProviders(
      <ChartRangeProvider>
        <Capture />
        <Profiler
          id="mirror"
          onRender={(_id, _phase, _actual, _base, _start, commit) =>
            commits.push(commit)
          }
        >
          <LiveMirrorChart
            subject="Network"
            upKey="net.tx_total"
            downKey="net.rx_total"
            upLabel="Upload"
            downLabel="Download"
            windowMs={60_000}
            accent="net"
            format={String}
            minCeiling={1}
          />
        </Profiler>
      </ChartRangeProvider>
    );
    await screen.findByRole("img", { name: /^Network: upload above the line/ });
    await waitFor(() => expect(store?.getState().layoutNo).not.toBeNull());
    await act(async () => {});
    for (let tick = 0; tick < 3; tick++) {
      const state = store?.getState();
      if (!state) throw new Error("Missing live store");
      commits.length = 0;
      await act(async () =>
        transport.push(nextFrame(state, { "net.tx_total": 1e6 * (tick + 1) }))
      );
      expect(commits).toHaveLength(1);
    }
  });
});

it("disables mirror interactions and gap bands while loading, independently of pending", () => {
  const gaps = [
    { fromMs: plot.firstMs, toMs: plot.firstMs + 10_000, label: "Asleep" },
  ];
  const r = renderWithProviders(
    <BrushProvider>
      <MirrorChart {...plot} brush loading gaps={gaps} />
    </BrushProvider>
  );
  expect(r.container.querySelector("[data-chart-loading]")).not.toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.queryByRole("note", { name: "Asleep" })).toBeNull();
  expect(r.container.querySelector("[data-crosshair]")).toBeNull();
  expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  expect(r.container.querySelector("[data-gap]")).toBeNull();
  r.unmount();
  renderWithProviders(
    <BrushProvider>
      <MirrorChart {...plot} brush gaps={gaps} />
    </BrushProvider>
  );
  expect(screen.getByRole("slider")).toBeInTheDocument();
  expect(screen.getByRole("note", { name: "Asleep" })).toBeInTheDocument();
  expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
});

it("holds live mirrored bars until the hour's backfill lands", async () => {
  vi.useFakeTimers();
  const r = renderWithProviders(
    <ChartRangeProvider>
      <LiveMirrorChart
        subject="Network"
        upKey="net.tx_total"
        downKey="net.rx_total"
        upLabel="Upload"
        downLabel="Download"
        windowMs={3_600_000}
        accent="net"
        format={String}
        minCeiling={1}
      />
    </ChartRangeProvider>,
    { transportOptions: { historyRows: 3600 }, backfillMs: 3_600_000 }
  );
  try {
    await act(async () => {});
    expect(r.container.querySelector("[data-chart-loading]")).not.toBeNull();
    expect(screen.queryByText("Loading chart history…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    expect(r.container.querySelector("[data-bars]")).toHaveClass(/reveal/);
  } finally {
    r.unmount();
    r.transport.dispose();
    vi.useRealTimers();
  }
});
