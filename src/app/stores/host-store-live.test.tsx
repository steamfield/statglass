/**
 * The live subscription against the D-066 channel: a channel that ends
 * silently is resubscribed (review #14), process interest follows the
 * stream, and the dashboard's hour arrives through earlier chunks.
 */
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { statusMsg } from "@tests/live-frames";
import { createTestQueryClient } from "@tests/test-utils";
import { useProcessInterest } from "~/hooks/use-process-interest";
import { useWindowSeries } from "~/hooks/use-window-series";
import { TransportProvider } from "~/lib/transport-context";
import { HostStoreProvider, useHost } from "./host-store";

const HOUR = 3_600_000;

function Probe() {
  const connection = useHost((s) => s.connection);
  const stale = useHost((s) => s.stale);
  return (
    <span data-testid="state">
      {connection} {String(stale)}
    </span>
  );
}

function Interested() {
  useProcessInterest({ limit: 5, sort: ["cpu"], period_ms: 5000 });
  return null;
}

function mount(transport: MockTransport, backfillMs?: number, extra = <></>) {
  return render(
    <TransportProvider transport={transport}>
      <HostStoreProvider hostId={MOCK_HOST_ID} backfillMs={backfillMs}>
        <Probe />
        {extra}
      </HostStoreProvider>
    </TransportProvider>
  );
}

const subscribes = (t: MockTransport) =>
  t.calls.filter((c) => c.command === "subscribe_live");

/** Advance fake time one interval and produce one frame. */
async function tick(t: MockTransport) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    t.tick();
  });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("a live channel that ends silently (#14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resubscribes after three more stale intervals with the full history horizon", async () => {
    const t = createMockTransport({ autoTick: false });
    const { getByTestId } = mount(t);
    await wait(0);
    await tick(t);
    await tick(t);
    expect(getByTestId("state").textContent).toBe("live false");

    // Frames stop: stale after three intervals, no resubscribe yet.
    await wait(3000);
    expect(getByTestId("state").textContent).toBe("live true");
    await wait(2900);
    expect(subscribes(t)).toHaveLength(1);

    await wait(100);
    expect(subscribes(t)).toHaveLength(2);
    expect(subscribes(t)[1]?.args[1]).toBe(60_000);
    expect(console.warn).toHaveBeenCalledWith(
      "[live] no frames while visible; resubscribing",
      expect.objectContaining({ hostId: MOCK_HOST_ID, window: "dashboard" })
    );

    // Frames resume on the new channel.
    await tick(t);
    expect(getByTestId("state").textContent).toBe("live false");
    t.dispose();
  });

  it.each([false, true])(
    "keeps the resume horizon after reconnect (Performance mode: %s)",
    async (performance) => {
      const t = createMockTransport({
        autoTick: false,
        historyRows: 3600,
        scenarios: performance ? ["performance-mode"] : [],
      });
      mount(t, HOUR, <ResumeSeries />);
      await wait(10);
      await tick(t);
      await wait(performance ? 12_000 : 6000);
      expect(subscribes(t)).toHaveLength(2);
      await tick(t);

      // A later hidden interval must still recover the full missed span.
      // backfillMs belongs to the stream's lifetime, not only this reconnect.
      act(() => {
        setVisibility("hidden");
        t.setWindowVisible(false);
      });
      for (let i = 0; i < 120; i++) await tick(t);
      act(() => {
        t.setWindowVisible(true);
        setVisibility("visible");
      });
      await wait(10);
      await tick(t);
      for (const values of Object.values(resumeSeries)) {
        expect(values).toHaveLength(performance ? 60 : 120);
        expect(values.filter((v) => v === null)).toHaveLength(0);
      }
      expect(subscribes(t)).toHaveLength(2);
      t.dispose();
    }
  );

  it("shows reconnecting until the new subscription answers", async () => {
    const t = createMockTransport({ autoTick: false });
    const { getByTestId } = mount(t);
    await wait(0);
    await tick(t);
    // The resubscribe hangs: the pill reads Reconnecting meanwhile.
    t.subscribeLive = () => new Promise(() => {});
    await wait(6000);
    expect(getByTestId("state").textContent).toBe("reconnecting true");
    t.dispose();
  });

  it("does not resubscribe while hidden or paused", async () => {
    const hidden = createMockTransport({ autoTick: false });
    const a = mount(hidden);
    await wait(0);
    await tick(hidden);
    setVisibility("hidden");
    await wait(60_000);
    expect(subscribes(hidden)).toHaveLength(1);
    a.unmount();
    setVisibility("visible");

    const paused = createMockTransport({
      autoTick: false,
      scenarios: ["paused"],
    });
    mount(paused);
    await wait(60_000);
    expect(subscribes(paused)).toHaveLength(1);
  });

  it("rebinds only the changed remote before the hidden window shows", async () => {
    const t = createMockTransport({
      autoTick: false,
      scenarios: ["hosts-dashboard"],
    });
    const [remote, other] = await t.listRemoteHosts();
    if (!remote || !other) throw new Error("Missing remote fixtures");
    setVisibility("hidden");
    t.setWindowVisible(false);
    const view = render(
      <TransportProvider transport={t}>
        <HostStoreProvider hostId={remote.config.id}>
          <Probe />
        </HostStoreProvider>
      </TransportProvider>
    );
    try {
      await wait(0);
      expect(subscribes(t)).toHaveLength(1);
      await act(() =>
        t.updateRemoteHost({ ...other.config, name: "Renamed other host" })
      );
      expect(subscribes(t)).toHaveLength(1);
      await act(() =>
        t.updateRemoteHost({ ...remote.config, name: "Renamed selected host" })
      );
      expect(subscribes(t)).toHaveLength(2);
      act(() => {
        t.setWindowVisible(true);
        setVisibility("visible");
      });
      await wait(0);
      expect(subscribes(t)).toHaveLength(2);
    } finally {
      view.unmount();
      t.dispose();
    }
  });

  it("pauses watchdog replacements until cached terminal host status clears", async () => {
    const t = createMockTransport({
      autoTick: false,
      scenarios: ["multi-host"],
    });
    const remote = (await t.listRemoteHosts()).find(
      ({ status }) => status.state === "connected"
    );
    if (!remote) throw new Error("Missing connected remote fixture");
    const client = createTestQueryClient();
    client.setQueryData(hostKeys.remote(), [
      {
        ...remote,
        status: {
          ...remote.status,
          state: "error",
          failure_kind: "authentication",
        },
      },
    ]);
    const view = render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={t}>
          <HostStoreProvider hostId={remote.config.id}>
            <Probe />
          </HostStoreProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
    try {
      await wait(0);
      expect(view.getByTestId("state")).toHaveTextContent("live false");
      await wait(3000);
      expect(view.getByTestId("state")).toHaveTextContent("live true");
      await wait(20_000);
      expect(subscribes(t)).toHaveLength(1);

      client.setQueryData(hostKeys.remote(), [remote]);
      await wait(5000);
      expect(subscribes(t)).toHaveLength(2);
    } finally {
      view.unmount();
      t.dispose();
    }
  });

  it("opens a stream when its missing host is registered", async () => {
    const t = createMockTransport({ autoTick: false, historyRows: 2 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = "remote-added-later";
    const view = render(
      <TransportProvider transport={t}>
        <HostStoreProvider hostId={id}>
          <Probe />
        </HostStoreProvider>
      </TransportProvider>
    );
    try {
      await wait(20_000);
      expect(subscribes(t)).toHaveLength(1);
      expect(view.getByTestId("state")).toHaveTextContent("reconnecting false");
      await act(async () => {
        const result = await t.addRemoteHost(
          {
            id,
            name: "Added host",
            lan: "later.local",
            tailscale: null,
            enabled: true,
            mirror_budget_mb: 100,
          },
          false,
          false,
          "late-registration"
        );
        expect(result.status).toBe("ok");
      });
      expect(subscribes(t)).toHaveLength(2);
      expect(view.getByTestId("state")).toHaveTextContent("live false");
    } finally {
      view.unmount();
      t.dispose();
    }
  });

  it("keeps the live indicator while a settings change opens a new stream", async () => {
    const t = createMockTransport({ autoTick: false });
    function view(backfillMs: number) {
      return (
        <TransportProvider transport={t}>
          <HostStoreProvider hostId={MOCK_HOST_ID} backfillMs={backfillMs}>
            <Probe />
          </HostStoreProvider>
        </TransportProvider>
      );
    }
    const rendered = render(view(60_000));
    try {
      await wait(0);
      await tick(t);
      expect(rendered.getByTestId("state")).toHaveTextContent("live false");
      const pending = vi
        .spyOn(t, "subscribeLive")
        .mockImplementation(() => new Promise(() => {}));
      rendered.rerender(view(HOUR));
      expect(pending).toHaveBeenCalledTimes(1);
      expect(rendered.getByTestId("state")).toHaveTextContent("live false");
    } finally {
      rendered.unmount();
      t.dispose();
    }
  });

  it("re-sends process interest with the new stream", async () => {
    const t = createMockTransport({ autoTick: false });
    mount(t, undefined, <Interested />);
    await wait(0);
    await tick(t);
    await wait(6000);
    const interest = t.calls
      .filter((c) => c.command === "set_process_interest")
      .map((c) => c.args[3]);
    expect(interest).toEqual([1, 2]);
    expect(t.processInterest()?.stream).toBe(2);
  });
});

describe("no frames by design is not stale (#13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not start a zero-delay retry loop before a remote reports its cadence", async () => {
    const t = createMockTransport({ autoTick: false });
    const view = mount(t);
    await wait(0);
    act(() =>
      t.push(
        statusMsg({
          interval_ms: 0,
          frame_period_ms: 0,
          power_source: "unknown",
        })
      )
    );
    await wait(1000);
    expect(subscribes(t)).toHaveLength(1);
    expect(view.getByTestId("state")).not.toHaveTextContent("reconnecting");
    view.unmount();
    t.dispose();
  });

  it("neither goes stale nor resubscribes while the display sleeps, and fills the gap on wake", async () => {
    const t = createMockTransport({ autoTick: false });
    const { getByTestId } = mount(t, HOUR, <LastTwoMinutes />);
    await wait(0);
    await tick(t);
    act(() => t.setDisplayIdle(true));
    for (let i = 0; i < 120; i++) await tick(t);
    expect(getByTestId("state").textContent).toBe("live false");
    expect(subscribes(t)).toHaveLength(1);

    act(() => t.setDisplayIdle(false));
    await wait(0);
    await tick(t);
    expect(getByTestId("state").textContent).toBe("live false");
    // The two asleep minutes arrived as backfill: no hole at the end.
    expect(last2m.every((v) => v !== null)).toBe(true);
    expect(subscribes(t)).toHaveLength(1);
    t.dispose();
  });

  it("measures stale in frame periods, not base ticks", async () => {
    const t = createMockTransport({ autoTick: false });
    const { getByTestId } = mount(t);
    await wait(0);
    await tick(t);
    // A channel thinned to one frame per 10 s (a v2 board's minimum period).
    act(() => t.push(statusMsg({ frame_period_ms: 10_000 })));
    await wait(29_000);
    expect(getByTestId("state").textContent).toBe("live false");
    expect(subscribes(t)).toHaveLength(1);
    await wait(1000);
    expect(getByTestId("state").textContent).toBe("live true");
    t.dispose();
  });
});

let resumeSeries: Record<string, (number | null)[]> = {};
function ResumeSeries() {
  resumeSeries = useWindowSeries(
    ["cpu.total", "gpu.util", "mem.pressure"],
    120_000
  ).values;
  return null;
}

let last2m: (number | null)[] = [];
function LastTwoMinutes() {
  last2m = useWindowSeries(["cpu.total"], 120_000).values["cpu.total"] ?? [];
  return null;
}

describe("the dashboard's hour of ring", () => {
  afterEach(() => vi.useRealTimers());

  let first: number | null | undefined;
  function HourProbe() {
    first = useWindowSeries(["cpu.total"], HOUR).values["cpu.total"]?.[0];
    return null;
  }

  it("fills the hour once the earlier chunks arrive", async () => {
    vi.useFakeTimers();
    const t = createMockTransport({ autoTick: false, historyRows: 3600 });
    mount(t, HOUR, <HourProbe />);
    await wait(0);
    // Two minutes before the first frame: the hour's first bucket is empty.
    expect(first).toBeNull();
    // The chunks follow the first frame, one per task.
    await tick(t);
    await wait(100);
    expect(first).toEqual(expect.any(Number));
    t.dispose();
  });
});
