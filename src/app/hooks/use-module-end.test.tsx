import type { ChartWindow } from "@core/generated/bindings";
import { USAGE_KEEP_MS } from "@core/generated/bindings";
import { act, screen } from "@testing-library/react";
import { ChartRangeProvider } from "~/stores/chart-range";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { renderWithProviders } from "../../../tests/test-utils";
import { useGridInterval } from "./use-grid-interval";
import { useModuleEnd, useUsageHistorical } from "./use-module-end";
import { useOpenEdge } from "./use-range-scope";

const END = 1_791_000_000_000;

function RangeProbe({ windowMs }: { windowMs: number }) {
  const end = useModuleEnd();
  const historical = useUsageHistorical(windowMs);
  return <p>{`end ${end ?? "none"} historical ${historical}`}</p>;
}

function renderRange(chartWindow: ChartWindow, windowMs: number) {
  renderWithProviders(
    <ChartRangeProvider>
      <RangeProbe windowMs={windowMs} />
    </ChartRangeProvider>,
    { transportOptions: { chartWindow } }
  );
}

describe("useModuleEnd and useUsageHistorical", () => {
  it("has no end and reads live usage for a rolling window within the ring", async () => {
    renderRange("15m", 900_000);
    expect(
      await screen.findByText("end none historical false")
    ).toBeInTheDocument();
  });

  it("reads retained usage for a rolling window past the ring", async () => {
    renderRange({ relative: USAGE_KEEP_MS + 60_000 }, USAGE_KEEP_MS + 60_000);
    expect(
      await screen.findByText("end none historical true")
    ).toBeInTheDocument();
  });

  it("returns the fixed end, which always reads retained usage", async () => {
    renderRange({ absolute: { from_ms: END - 900_000, to_ms: END } }, 900_000);
    expect(
      await screen.findByText(`end ${END} historical true`)
    ).toBeInTheDocument();
  });

  it("has no end outside a range provider", () => {
    renderWithProviders(<RangeProbe windowMs={900_000} />);
    expect(screen.getByText("end none historical false")).toBeInTheDocument();
  });
});

let store: HostStore | null = null;
function EdgeProbe({ stepMs }: { stepMs?: number }) {
  store = useHostStore();
  const edge = useOpenEdge(true, stepMs);
  const interval = useGridInterval();
  return <p>{`edge ${edge ?? "none"} interval ${interval}`}</p>;
}

describe("useOpenEdge", () => {
  it("snaps the newest sample to the 10 s brush grid by default", () => {
    renderWithProviders(<EdgeProbe />);
    act(() => store?.setState({ lastTsMs: 1_234_567 }));
    expect(screen.getByText(/^edge 1230000 /)).toBeInTheDocument();
  });

  it("snaps to a given step", () => {
    renderWithProviders(<EdgeProbe stepMs={60_000} />);
    act(() => store?.setState({ lastTsMs: 1_234_567 }));
    expect(screen.getByText(/^edge 1200000 /)).toBeInTheDocument();
  });
});

describe("useGridInterval", () => {
  it("follows the slower of the interval and the frame period", () => {
    renderWithProviders(<EdgeProbe />);
    expect(screen.getByText(/interval 1000$/)).toBeInTheDocument();
    act(() => {
      const status = store?.getState().status;
      if (status)
        store?.setState({
          status: { ...status, interval_ms: 1000, frame_period_ms: 2000 },
        });
      else throw new Error("no live status yet");
    });
    expect(screen.getByText(/interval 2000$/)).toBeInTheDocument();
  });
});
