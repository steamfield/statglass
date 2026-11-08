import { BRUSH_STEP_MS } from "@core/brush";
import { eventLabel, eventRange } from "@core/events";
import { formatClock, monthName } from "@core/format";
import type { Event } from "@core/generated/bindings";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { DAY_MS } from "@core/time-grid";
import { act, screen, waitFor, within } from "@testing-library/react";
import { pushLayout } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler, useState } from "react";
import { HostClockContext } from "~/lib/host-clock";
import { ChartRangeProvider } from "~/stores/chart-range";
import { OverviewEventsCard } from "./events-card";

const NOW = 1_800_000_000_000;
const WINDOW = 900_000;
const event = (ago: number, name = String(ago)): Event => ({
  ts_ms: NOW - ago,
  start_ms: NOW - ago - 60_000,
  detail: { kind: "sustained_process", process: name, cpu_pct: 80, secs: 60 },
  processes: [],
});

function setup({
  events = [event(100_000, "Compiler")],
  windowMs = WINDOW,
  transport = createMockTransport({ autoTick: false, now: () => NOW }),
} = {}) {
  transport.queryEvents = async () => ({ status: "ok", data: events });
  const renders = { n: 0 };
  const view = renderWithProviders(
    <HostClockContext.Provider value={() => NOW}>
      <ChartRangeProvider>
        <Profiler id="events" onRender={() => renders.n++}>
          <OverviewEventsCard windowMs={windowMs} origin="tl" />
        </Profiler>
      </ChartRangeProvider>
    </HostClockContext.Provider>,
    { transport, route: "/dashboard/overview" }
  );
  return { ...view, renders };
}

it("clips to half-open bounds, counts every event, and lists the newest six", async () => {
  const events = [
    event(WINDOW + 1, "Too old"),
    event(0, "At end"),
    ...Array.from({ length: 8 }, (_, i) =>
      event(WINDOW - i * 60_000, `App ${i}`)
    ),
  ];
  setup({ events });
  const list = await screen.findByRole("list", { name: "Recent events" });
  expect(
    within(list)
      .getAllByRole("button")
      .map((row) => row.textContent)
  ).toEqual(
    events
      .slice(4)
      .reverse()
      .map((e) => formatClock(e.ts_ms) + eventLabel(e))
  );
  expect(screen.getByText("8 in last 15 minutes")).toBeVisible();
  expect(screen.queryByText(/Too old|At end|App 0|App 1/)).toBeNull();
});

it("dates an event from an earlier day than the range's end", async () => {
  const earlier = event(DAY_MS + 100_000, "Compiler");
  setup({ events: [earlier], windowMs: 2 * DAY_MS });
  const d = new Date(earlier.ts_ms);
  expect(
    await screen.findByRole("button", { name: /Compiler/ })
  ).toHaveTextContent(
    `${monthName(d)} ${d.getDate()}, ${formatClock(earlier.ts_ms)}`
  );
});

it("uses warning priority for an icon and leaves recovery informational", async () => {
  const warning = event(100_000, "Compiler");
  const recovery: Event = {
    ...event(200_000),
    detail: { kind: "thermal_state", from: "critical", to: "nominal" },
  };
  setup({ events: [recovery, warning] });
  await screen.findByRole("list");
  expect(
    screen.getByRole("button", { name: /Compiler/ }).querySelector("svg")
  ).not.toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Thermal state Nominal/ })
      .querySelector("svg")
  ).toBeNull();
});

it("shows the loading state until the event query resolves", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = transport.queryEvents;
  transport.queryEvents = async (...args) => {
    await gate;
    return read(...args);
  };
  renderWithProviders(<OverviewEventsCard origin="tl" windowMs={WINDOW} />, {
    transport,
  });
  expect(screen.getByText("Loading chart history…")).toBeVisible();
  await act(async () => release());
  await screen.findByText(/Nothing detected/);
});

it("distinguishes a read error from unavailable history", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.queryEvents = async () => ({
    status: "error",
    error: { kind: "internal", message: "read failed" },
  });
  renderWithProviders(<OverviewEventsCard origin="tl" windowMs={WINDOW} />, {
    transport,
  });
  expect(await screen.findByText("Couldn't load events")).toBeVisible();
  expect(screen.queryByText(/Nothing detected/)).toBeNull();
});

it("uses the existing history-unavailable wording", async () => {
  renderWithProviders(<OverviewEventsCard origin="tl" windowMs={WINDOW} />, {
    transportOptions: { scenarios: ["history-unavailable"] },
  });
  expect(
    await screen.findByText("History is unavailable. Live values still work.")
  ).toBeVisible();
  expect(screen.queryByText(/Nothing detected/)).toBeNull();
});

it.each([false, true])(
  "uses range-aware empty wording (absolute: %s)",
  async (absolute) => {
    const transport = createMockTransport({
      now: () => NOW,
      autoTick: false,
      chartWindow: absolute
        ? { absolute: { from_ms: NOW - WINDOW, to_ms: NOW } }
        : "15m",
    });
    setup({ events: [], transport });
    expect(
      await screen.findByText(
        absolute
          ? /Nothing detected between/
          : "Nothing detected in the last 15 minutes"
      )
    ).toBeVisible();
    if (absolute)
      expect(screen.queryByText(/Nothing detected in the last/)).toBeNull();
  }
);

it("waits for the range save before navigating, and respects trimmed history", async () => {
  const e = event(100_000, "Compiler");
  const { transport, router, user, queryClient } = setup({ events: [e] });
  await screen.findByRole("button", { name: /Compiler/ });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const health = await transport.historyHealth(MOCK_HOST_ID);
  if (health.status !== "ok") throw new Error("expected health");
  const retained = NOW - 150_000;
  act(() =>
    transport.setHistoryHealth({ ...health.data, trimmed_before_ms: retained })
  );
  await screen.findByRole("button", { name: /Compiler/ });
  const update = transport.updateSettings;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi
    .spyOn(transport, "updateSettings")
    .mockImplementation(async (...args) => {
      await gate;
      return update(...args);
    });
  await user.click(screen.getByRole("button", { name: /Compiler/ }));
  expect(save).toHaveBeenCalledWith({
    general: {
      chart_window: { absolute: { from_ms: retained, to_ms: NOW - 40_000 } },
    },
  });
  expect(router.state.location.pathname).toBe("/dashboard/overview");
  await act(async () => release());
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/dashboard/timeline")
  );
});

it("navigates when apply returns false for an already selected range", async () => {
  const e = event(100_000, "Compiler");
  const range = eventRange([e], BRUSH_STEP_MS, NOW);
  if (!range) throw new Error("expected range");
  const transport = createMockTransport({
    autoTick: false,
    now: () => NOW,
    chartWindow: { absolute: { from_ms: range.fromMs, to_ms: range.toMs } },
  });
  const save = vi.spyOn(transport, "updateSettings");
  const { router, user, queryClient } = setup({ events: [e], transport });
  await screen.findByRole("button", { name: /Compiler/ });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await user.click(screen.getByRole("button", { name: /Compiler/ }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/dashboard/timeline")
  );
  expect(save).not.toHaveBeenCalled();
});

it("does not render on a 1 Hz frame within the open bucket", async () => {
  const { transport, renders, queryClient } = setup();
  await screen.findByRole("list");
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const push = pushLayout(transport, 42, []);
  push(NOW + 1000, []);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const before = renders.n;
  push(NOW + 2000, []);
  expect(renders.n).toBe(before);
});

it("hides the old count while a larger event range loads", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.queryEvents = async (_host, fromMs) => {
    if (fromMs < NOW - WINDOW) {
      await gate;
      return { status: "ok", data: [event(100_000), event(3_600_000)] };
    }
    return { status: "ok", data: [event(100_000)] };
  };
  function ChangingCard() {
    const [windowMs, setWindowMs] = useState(WINDOW);
    return (
      <HostClockContext.Provider value={() => NOW}>
        <button type="button" onClick={() => setWindowMs(DAY_MS)}>
          Day
        </button>
        <OverviewEventsCard windowMs={windowMs} origin="tl" />
      </HostClockContext.Provider>
    );
  }
  const { user } = renderWithProviders(<ChangingCard />, { transport });
  await screen.findByText("1 in last 15 minutes");
  await user.click(screen.getByRole("button", { name: "Day" }));
  expect(screen.getByText("Loading chart history…")).toBeVisible();
  expect(screen.queryByText(/1 in last/)).toBeNull();
  await act(async () => release());
  await screen.findByText("2 in last day");
});
