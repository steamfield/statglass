import type { RemoteHostStatus } from "./generated/types";
import { createLiveSession, initialLiveSessionState } from "./live-session";
import { ringLoading, seriesWindow } from "./live-state";
import { MOCK_HOST_ID } from "./mock/fixtures";
import { createMockTransport } from "./mock-transport";
import type { LiveSubscription, Transport } from "./transport";

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function startSession(
  transport: Pick<Transport, "subscribeLive">,
  host = MOCK_HOST_ID,
  status: () => RemoteHostStatus | null = () => null,
  { backfillMs = 60_000, visible = true } = {}
) {
  let state = initialLiveSessionState(host);
  const session = createLiveSession(
    host,
    { backfillMs },
    {
      initial: state,
      subscribe: transport.subscribeLive,
      apply: (next) => {
        state = next;
      },
      clock: { now: Date.now, setTimeout, clearTimeout },
      visible: () => visible,
      onVisible: () => () => {},
      status,
    }
  );
  return { ...session, state: () => state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("prewarms a hidden channel so native show can deliver history", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  transport.setWindowVisible(false);
  const session = startSession(transport, MOCK_HOST_ID, () => null, {
    visible: false,
  });
  try {
    await advance(0);
    expect(transport.subscriberCount()).toBe(1);
    expect(seriesWindow(session.state(), "cpu.total", 2000).values).toEqual([
      null,
      null,
    ]);
    transport.setWindowVisible(true);
    await advance(1);
    expect(seriesWindow(session.state(), "cpu.total", 2000).values).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
  } finally {
    session.stop();
    transport.dispose();
  }
});

it("fills a missed sample and waits for the full chart at the published catch-up limit", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 140 });
  const original = transport.subscribeLive;
  vi.spyOn(transport, "subscribeLive")
    .mockImplementationOnce(async (host, receive, options) => {
      let missed = 0;
      const sub = await original(
        host,
        (msg) => {
          if (msg.kind === "frame" && missed < 2) {
            missed++;
            return;
          }
          receive(msg);
        },
        options
      );
      if (sub.info.status === "ok") {
        return {
          ...sub,
          info: { status: "ok", data: { ...sub.info.data, recent_ms: 4500 } },
        };
      }
      return sub;
    })
    .mockImplementationOnce(() => new Promise(() => {}));
  const session = startSession(transport, MOCK_HOST_ID, () => null, {
    backfillMs: 130_000,
  });
  const chart = () => seriesWindow(session.state(), "cpu.total", 4000);
  try {
    await advance(1000);
    transport.tick();
    await advance(1000);
    transport.tick();
    await advance(1000);
    transport.tick();
    const before = chart();
    expect(before.values).toEqual([
      expect.any(Number),
      null,
      null,
      expect.any(Number),
    ]);

    // The desktop allows two ticks for catch-up delivery.
    await advance(2499);
    session.retry();
    expect(chart()).toEqual(before);
    await advance(1);
    session.retry();
    await advance(0);
    expect(chart()).toEqual({
      ...before,
      values: Array.from({ length: 4 }, () => expect.any(Number)),
    });
    expect(ringLoading(session.state(), 130_000)).toBe(true);

    await advance(1500);
    expect(ringLoading(session.state(), 130_000)).toBe(false);
    transport.tick();
    expect(chart().tEndMs).toBe(Date.now());
  } finally {
    session.stop();
    transport.dispose();
  }
});

it("backs off after a typed command failure and waits for terminal host status to clear", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["multi-host"],
  });
  const remote = (await transport.listRemoteHosts())[0];
  if (!remote) throw new Error("Missing remote host fixture");
  const host = remote.config.id;
  let status = { ...remote.status };
  const missing: LiveSubscription = {
    info: { status: "error", error: { kind: "unknown_host", host } },
    unsubscribe() {},
  };
  const subscribe = vi
    .spyOn(transport, "subscribeLive")
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(missing);
  const session = startSession(transport, host, () => status);
  try {
    await advance(499);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(session.state().connection).toBe("reconnecting");
    await advance(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await advance(999);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(subscribe).toHaveBeenCalledTimes(3);

    status = { ...status, state: "error", failure_kind: "authentication" };
    await advance(20_000);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(session.state().terminal?.failure_kind).toBe("authentication");

    status = { ...status, state: "connected", failure_kind: null };
    await advance(5000);
    expect(subscribe).toHaveBeenCalledTimes(4);
    expect(session.state().terminal).toBeNull();
  } finally {
    session.stop();
    transport.dispose();
  }
});
