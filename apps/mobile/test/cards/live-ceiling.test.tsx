/** The live CPU chart's autoscale while samples advance and cadence changes. */
import { SHRINK_AFTER_MS } from "@core/chart-math";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { afterEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { useHostLiveSubscription } from "@/data/live";
import { useCompactStream } from "@/data/live-stream";
import { StreamArea } from "@/widgets/stream-area";

const FAST_TICK_MS = 1000;
const SLOW_TICK_MS = 2000;
const WINDOW_MS = 5 * MINUTE_MS;
const AGENT_TICK_MS = 10_000;
const LATE_AGENT_FRAME_MS = 15_000;
const LONG_FRAME_GAP_MS = 11_000;
const CPU_LAYOUT = 42;
const TIMELINE = 0;
const HIGH_CPU = 90;
const LOW_CPU = 12;
const IDLE_CPU = 4;

function CpuChart() {
  useHostLiveSubscription(MOCK_HOST_ID);
  const chart = useCompactStream(MOCK_HOST_ID, {
    seriesKey: "cpu.total",
    accent: "cpu",
    subject: "CPU",
    height: 52,
  });
  return chart && <StreamArea {...chart} />;
}

async function renderCpuChart(intervalMs = SLOW_TICK_MS) {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 0,
    intervalMs,
  });
  await renderWithProviders(
    <ExpoRoot context={getMockContext({ index: CpuChart })} location="/" />,
    { transport, settings: { chartWindowMs: WINDOW_MS } }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() =>
    transport.push({
      kind: "layout",
      layout_no: CPU_LAYOUT,
      kinds: ["gauge"],
      series: [{ metric: "cpu.total", labels: [] }],
    })
  );
  return transport;
}

function pushCpu(transport: MockTransport, percent: number) {
  transport.push({
    kind: "frame",
    ts_ms: Date.now(),
    layout_no: CPU_LAYOUT,
    timeline: TIMELINE,
    values: [percent],
    held: [percent],
  });
}

async function advanceToCpuFrame(
  transport: MockTransport,
  percent: number,
  gapMs: number
) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(gapMs);
    pushCpu(transport, percent);
  });
}

async function sampleCpu(
  transport: MockTransport,
  percent: number,
  durationMs: number,
  tickMs = SLOW_TICK_MS
) {
  for (let elapsed = tickMs; elapsed <= durationMs; elapsed += tickMs) {
    await advanceToCpuFrame(transport, percent, tickMs);
  }
}

afterEach(() => {
  jest.useRealTimers();
});

test("the CPU ceiling holds after a peak ages out and a faster cadence keeps the chosen window", async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 24, 15, 2, 8) });
  mockAppState();
  const transport = await renderCpuChart();
  await act(() => pushCpu(transport, HIGH_CPU));
  expect(screen.getByText("100%")).toBeOnTheScreen();
  // Keep the high reading across more than one bucket so it still sets the scale after averaging.
  await sampleCpu(transport, HIGH_CPU, 10_000);

  // The hold starts when the high sample leaves the five-minute window.
  await sampleCpu(transport, LOW_CPU, WINDOW_MS + SHRINK_AFTER_MS - 10_000);
  expect(screen.getByText("100%")).toBeOnTheScreen();

  // A gap longer than 10 seconds restarts the hold even though the next sample is low.
  await advanceToCpuFrame(transport, LOW_CPU, LONG_FRAME_GAP_MS);
  expect(screen.getByText("100%")).toBeOnTheScreen();
  await sampleCpu(transport, LOW_CPU, SHRINK_AFTER_MS - 3 * SLOW_TICK_MS);
  // A single missed sample leaves the hold running.
  await advanceToCpuFrame(transport, LOW_CPU, 2 * SLOW_TICK_MS);
  expect(screen.getByText("100%")).toBeOnTheScreen();
  await advanceToCpuFrame(transport, LOW_CPU, SLOW_TICK_MS);
  expect(screen.getByText("20%")).toBeOnTheScreen();

  // One minute of idle samples cannot remove the earlier 12% from the window.
  await sampleCpu(transport, IDLE_CPU, MINUTE_MS);
  expect(screen.getByText("20%")).toBeOnTheScreen();
  await act(async () => {
    await unwrap(
      transport.updateSettings({ sampling: { interval_ms: FAST_TICK_MS } })
    );
  });
  expect(
    screen.getByRole("image", { name: "CPU, last 5 minutes." })
  ).toBeOnTheScreen();
  expect(screen.getByText("20%")).toBeOnTheScreen();
});

test("a late frame from a ten-second host leaves the ceiling's hold running", async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 24, 15, 2, 8) });
  mockAppState();
  const transport = await renderCpuChart(AGENT_TICK_MS);
  await act(() => pushCpu(transport, HIGH_CPU));
  expect(screen.getByText("100%")).toBeOnTheScreen();

  await sampleCpu(
    transport,
    LOW_CPU,
    WINDOW_MS + SHRINK_AFTER_MS - 2 * AGENT_TICK_MS,
    AGENT_TICK_MS
  );
  // Under two periods late is still the same run of samples.
  await advanceToCpuFrame(transport, LOW_CPU, LATE_AGENT_FRAME_MS);
  expect(screen.getByText("100%")).toBeOnTheScreen();
  await advanceToCpuFrame(transport, LOW_CPU, AGENT_TICK_MS);
  expect(screen.getByText("20%")).toBeOnTheScreen();
});
