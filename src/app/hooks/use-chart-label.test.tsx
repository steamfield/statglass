import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { useHost } from "~/stores/host-store";
import { type ChartLabel, useChartLabel } from "./use-chart-label";

/** A chart whose figure moves every tick, like a live CPU percentage. */
function Probe(props: Omit<ChartLabel, "now"> & { live?: boolean }) {
  const ts = useHost((s) => s.lastTsMs);
  const label = useChartLabel({
    ...props,
    now: props.live === false ? undefined : `now ${ts ?? "none"}`,
  });
  return <span data-testid="label">{label}</span>;
}

const label = () => screen.getByTestId("label").textContent;

describe("useChartLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mid-bucket, so the first 10 s edge falls inside the run.
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 3));
  });
  afterEach(() => vi.useRealTimers());

  it("changes its figures at most every 10 s of 1 Hz frames", async () => {
    const { transport } = renderWithProviders(
      <Probe subject="CPU" span="last 60 seconds" />
    );
    const seen: string[] = [];
    for (let i = 0; i < 35; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        transport.tick();
      });
      seen.push(label() ?? "");
    }
    // Index of each tick where the name changed.
    const changes = seen.flatMap((s, i) =>
      i > 0 && s !== seen[i - 1] ? [i] : []
    );
    expect(changes.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < changes.length; k++) {
      expect((changes[k] as number) - (changes[k - 1] as number)).toBe(10);
    }
    expect(seen.at(-1)).toMatch(/^CPU, last 60 seconds, now \d+\.$/);
  });

  it("applies a new span at once, with fresh figures", async () => {
    let widen: () => void = () => {};
    function Owner() {
      const [wide, setWide] = useState(false);
      widen = () => setWide(true);
      return wide ? (
        <Probe subject="CPU" span="last 15 minutes" brushable />
      ) : (
        <Probe subject="CPU" span="last 60 seconds" />
      );
    }
    const { transport } = renderWithProviders(<Owner />);
    // 12:00:04 and 12:00:05: one bucket, so the name holds the first figure.
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        transport.tick();
      });
    }
    const held = label();
    act(() => widen());
    const fresh = label();
    expect(fresh).toMatch(
      /^CPU, last 15 minutes, now \d+\. Drag to select a range\.$/
    );
    expect(fresh?.match(/now \d+/)?.[0]).not.toBe(held?.match(/now \d+/)?.[0]);
  });

  it("takes the first real figures at once while frames are stalled", async () => {
    let setNow: (now: string) => void = () => {};
    function HistoryProbe() {
      const [now, set] = useState("now —");
      setNow = set;
      return (
        <span data-testid="label">
          {useChartLabel({ subject: "GPU", span: "last 15 minutes", now })}
        </span>
      );
    }
    const { transport } = renderWithProviders(<HistoryProbe />);
    await act(async () => transport.tick());
    expect(label()).toBe("GPU, last 15 minutes, now —.");
    // The history read lands with no new frame: the figures replace the dash.
    act(() => setNow("now 34%"));
    expect(label()).toBe("GPU, last 15 minutes, now 34%.");
    // Real figures hold for the bucket again.
    act(() => setNow("now 40%"));
    expect(label()).toBe("GPU, last 15 minutes, now 34%.");
  });

  it("reads without figures and without the stream", () => {
    renderWithProviders(
      <Probe
        subject="Network: up above, down below"
        span="last 48 seconds"
        live={false}
      />
    );
    expect(label()).toBe("Network: up above, down below, last 48 seconds.");
  });
});
