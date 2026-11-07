import { act, screen, waitFor } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { LiveMirrorChart } from "~/components/live-mirror-chart";
import { ChartRangeProvider } from "~/stores/chart-range";
import { type HostStore, useHostStore } from "~/stores/host-store";
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

  it("names actual times once the range's end is fixed", () => {
    renderWithProviders(
      <MirrorChart {...plot} fixedEndMs={plot.firstMs + 40_000} />
    );
    expect(screen.queryByText("now")).toBeNull();
  });

  it("moves one crosshair across sibling plots without rendering", () => {
    const onHoverTime = vi.fn();
    const { container } = renderWithProviders(
      <>
        <MirrorChart {...plot} onHoverTime={onHoverTime} axis={false} />
        <MirrorChart
          {...plot}
          subject="Operations/s"
          onHoverTime={onHoverTime}
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
