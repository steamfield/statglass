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
const SLOW_WINDOW_MS = 2 * MINUTE_MS;
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

async function renderCpuChart() {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 0,
    intervalMs: SLOW_TICK_MS,
  });
  await renderWithProviders(
    <ExpoRoot context={getMockContext({ index: CpuChart })} location="/" />,
    { transport }
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
  durationMs: number
) {
  for (
    let elapsed = SLOW_TICK_MS;
    elapsed <= durationMs;
    elapsed += SLOW_TICK_MS
  ) {
    await advanceToCpuFrame(transport, percent, SLOW_TICK_MS);
  }
}

afterEach(() => {
  jest.useRealTimers();
});

test("the live CPU ceiling holds after a peak ages out and refits when the window changes", async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 24, 15, 2, 8) });
  mockAppState();
  const transport = await renderCpuChart();
  await act(() => pushCpu(transport, HIGH_CPU));
  expect(screen.getByText("100%")).toBeOnTheScreen();

  // The hold starts when the high sample leaves the two-minute window.
  await sampleCpu(
    transport,
    LOW_CPU,
    SLOW_WINDOW_MS + SHRINK_AFTER_MS - SLOW_TICK_MS
  );
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

  // One minute of idle samples fits the new window. The old one still includes 12%.
  await sampleCpu(transport, IDLE_CPU, MINUTE_MS);
  expect(screen.getByText("20%")).toBeOnTheScreen();
  await act(async () => {
    await unwrap(
      transport.updateSettings({ sampling: { interval_ms: FAST_TICK_MS } })
    );
  });
  expect(
    screen.getByRole("image", { name: "CPU, last 60 seconds." })
  ).toBeOnTheScreen();
  expect(screen.getByText("10%")).toBeOnTheScreen();
});
