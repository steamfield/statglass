import { formatWatts } from "@core/format";
import type { LiveMsg } from "@core/generated/types";
import { selectCpu } from "@core/live-selectors";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { useLayoutEffect, useState } from "react";
import { Pressable } from "react-native";
import { useHostLive, useHostLiveSubscription } from "@/data/live";
import { useCompactStream, useNetworkBars } from "@/data/live-stream";
import { Text } from "@/ui/text";
import { MirrorBars } from "@/widgets/mirror-bars";
import { StreamArea } from "@/widgets/stream-area";

const start = Date.UTC(2026, 10, 24, 15, 2, 8);

function ChartScreen() {
  const [reading, setReading] = useState("—");
  useHostLiveSubscription(MOCK_HOST_ID);
  const cpu = useCompactStream(MOCK_HOST_ID, {
    accent: "cpu",
    seriesKey: "cpu.total",
    subject: "CPU",
    now: reading,
    height: 52,
    yMax: 100,
  });
  const watts = useCompactStream(MOCK_HOST_ID, {
    accent: "power",
    seriesKey: "power.system",
    subject: "System power",
    height: 40,
    yMax: 20,
    formatCeiling: formatWatts,
  });
  const network = useNetworkBars(MOCK_HOST_ID);
  return (
    <>
      {cpu && <StreamArea {...cpu} />}
      {watts && <StreamArea {...watts} />}
      {network && <MirrorBars {...network} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Change CPU reading"
        onPress={() => setReading((value) => (value === "—" ? "10%" : "20%"))}
      />
    </>
  );
}

const context = getMockContext({ index: ChartScreen });

async function renderCharts() {
  // The host clock advances independently of the phone's monotonic clock.
  let edgeMs = start;
  const transport = createMockTransport({
    autoTick: false,
    now: () => edgeMs,
    historyRows: 301,
  });
  await renderWithProviders(
    <ExpoRoot context={context} location={new URL("statglass:///")} />,
    { transport, settings: { chartWindowMs: 5 * MINUTE_MS } }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await screen.findByRole(
    "image",
    { name: /^CPU, last 5 minutes/, busy: false },
    { timeout: 2000 }
  );
  return (ms: number) => {
    edgeMs = start + ms;
    return act(() => transport.tick());
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: start });
  mockAppState();
});
afterEach(() => {
  jest.useRealTimers();
});

test("the chart takes the first real reading and holds it until the host bucket changes", async () => {
  const tick = await renderCharts();
  await tick(0);
  const cpu = (reading: string) =>
    screen.getByRole("image", {
      name: `CPU, last 5 minutes, now ${reading}.`,
    });
  const change = () =>
    fireEvent.press(screen.getByRole("button", { name: "Change CPU reading" }));

  expect(cpu("—")).toBeOnTheScreen();
  await change();
  expect(cpu("10%")).toBeOnTheScreen();
  await change();
  await tick(1000);
  expect(cpu("10%")).toBeOnTheScreen();
  await tick(2000);
  expect(cpu("20%")).toBeOnTheScreen();
});

test("the chart uses the caller's ceiling units", async () => {
  const tick = await renderCharts();
  await tick(0);
  expect(screen.getByText("20.0 W")).toBeOnTheScreen();
  expect(screen.queryByText("20%")).toBeNull();
});

test("the Network plot uses the desktop's direction and time wording", async () => {
  const tick = await renderCharts();
  await tick(0);
  expect(
    screen.getByRole("image", {
      name: "Network: upload above the line, download below, last 5 minutes.",
    })
  ).toBeOnTheScreen();
});

test("a frame changing only the held CPU value leaves the GPU and Network windows stable", async () => {
  const gpuCommits: ReturnType<typeof useCompactStream>[] = [];
  const networkCommits: ReturnType<typeof useNetworkBars>[] = [];
  const messages: LiveMsg[] = [];
  const mock = createMockTransport({ autoTick: false, historyRows: 2 });
  const transport = {
    ...mock,
    subscribeLive: ((host, receive, options) =>
      mock.subscribeLive(
        host,
        (message) => {
          messages.push(message);
          receive(message);
        },
        options
      )) satisfies typeof mock.subscribeLive,
  };

  function GpuWindow() {
    const stream = useCompactStream(MOCK_HOST_ID, {
      accent: "gpu",
      seriesKey: "gpu.util",
      subject: "GPU",
      height: 40,
    });
    useLayoutEffect(() => {
      gpuCommits.push(stream);
    });
    return null;
  }

  function NetworkWindow() {
    const bars = useNetworkBars(MOCK_HOST_ID);
    useLayoutEffect(() => {
      networkCommits.push(bars);
    });
    return null;
  }

  function CpuReading() {
    const total = useHostLive(MOCK_HOST_ID, (state) => selectCpu(state).total);
    return <Text variant="value">CPU {total}%</Text>;
  }

  function WindowsScreen() {
    useHostLiveSubscription(MOCK_HOST_ID);
    return (
      <>
        <CpuReading />
        <GpuWindow />
        <NetworkWindow />
      </>
    );
  }

  await renderWithProviders(
    <ExpoRoot
      context={getMockContext({ index: WindowsScreen })}
      location={new URL("statglass:///")}
    />,
    { transport }
  );
  await waitFor(() => expect(mock.subscriberCount()).toBe(1));
  await act(() => mock.tick());
  await waitFor(() => {
    expect(gpuCommits.at(-1)?.loading).toBe(false);
    expect(networkCommits.at(-1)?.loading).toBe(false);
  });
  const frame = messages.find((message) => message.kind === "frame");
  const layout = messages.find(
    (message) =>
      message.kind === "layout" && message.layout_no === frame?.layout_no
  );
  if (!frame || layout?.kind !== "layout")
    throw new Error("The mock must provide a frame and its layout");
  const cpu = layout.series.findIndex(({ metric }) => metric === "cpu.total");
  expect(cpu).toBeGreaterThanOrEqual(0);
  const gpu = gpuCommits.at(-1);
  const network = networkCommits.at(-1);
  expect(gpu).toBeTruthy();
  expect(network).toBeTruthy();
  const gpuCount = gpuCommits.length;
  const networkCount = networkCommits.length;
  const total = frame.held[cpu] === 99 ? 98 : 99;

  await act(() =>
    mock.push({
      ...frame,
      held: frame.held.map((value, index) => (index === cpu ? total : value)),
    })
  );

  expect(screen.getByText(`CPU ${total}%`)).toBeOnTheScreen();
  expect(gpuCommits.at(-1)).toBe(gpu);
  expect(networkCommits.at(-1)).toBe(network);
  expect(gpuCommits).toHaveLength(gpuCount);
  expect(networkCommits).toHaveLength(networkCount);
});
