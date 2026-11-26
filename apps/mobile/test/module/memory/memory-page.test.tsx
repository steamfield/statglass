import { formatBytes, MISSING } from "@core/format";
import { METRIC_CODES } from "@core/generated/types";
import { MEM_TOTAL_BYTES, MOCK_HOST_ID } from "@core/mock/fixtures";
import { LINUX_MEM_TOTAL_BYTES } from "@core/mock/linux";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { ExpoRoot, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import { ModuleScreen } from "@/module";

const context = getMockContext({
  _layout: () => <Stack />,
  "[host]/[module]": ModuleScreen,
});
const now = Date.UTC(2026, 10, 24, 15, 2);

beforeEach(() => {
  jest.useFakeTimers({ now });
  mockAppState();
});
afterEach(() => {
  jest.useRealTimers();
});

async function openMemory(transport: MockTransport) {
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}/memory`)}
    />,
    { transport }
  );
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await act(() => transport.tick());
}

test("Mac Memory shows unified capacity, composition, pressure, host peaks and swap", async () => {
  const transport = createMockTransport({ autoTick: false });
  const hostHistory = transport.hostHistory;
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => {
    const result = await hostHistory(request);
    if (result.status === "error") return result;
    return {
      status: "ok",
      data: {
        ...result.data,
        stats: result.data.stats.map((stat) => {
          if (stat.key.metric === "mem.used") return { ...stat, peak: 18e9 };
          if (stat.key.metric === "mem.swap_used")
            return { ...stat, peak: 80e6 };
          return stat;
        }),
      },
    };
  });
  await openMemory(transport);
  expect(screen.getByText("24 GB unified")).toBeOnTheScreen();
  expect(screen.getByLabelText("Used")).toHaveAccessibilityValue({
    text: /GB$/,
  });
  expect(screen.getByLabelText("Pressure")).toHaveAccessibilityValue({
    text: /% normal$/,
  });
  expect(screen.getByLabelText("Swap")).toHaveAccessibilityValue({
    text: /B$/,
  });
  expect(screen.getByLabelText("Compressed")).toHaveAccessibilityValue({
    text: /B$/,
  });
  expect(screen.getByLabelText("Peak used")).toHaveAccessibilityValue({
    text: formatBytes(18e9),
  });
  expect(screen.getByLabelText("Peak swap")).toHaveAccessibilityValue({
    text: formatBytes(80e6),
  });
  expect(
    screen.getByRole("image", {
      name: /App.*Wired.*Compressed.*Cached files.*Free/,
    })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", { name: "Memory pressure" })
  ).toBeOnTheScreen();
  expect(screen.getByRole("header", { name: "Swap" })).toBeOnTheScreen();
  expect(screen.getByText("In")).toBeOnTheScreen();
  expect(screen.getByText("Out")).toBeOnTheScreen();
  expect(screen.getAllByText(/\d pages\/s/)).toHaveLength(2);
  expect(
    screen.getByRole("adjustable", { name: "Swap used" })
  ).toBeOnTheScreen();
  const top = ["Xcode", "Safari", "com.docker.backend"];
  expect(
    screen.getAllByLabelText(/^(Xcode|Safari|com\.docker\.backend)$/)
  ).toEqual(top.map((name) => screen.getByLabelText(name)));
  expect(screen.getAllByHintText("Memory")).toContain(
    screen.getByLabelText("Xcode")
  );
  expect(screen.queryByText(/By app|Every process/i)).not.toBeOnTheScreen();
});

test("Linux Memory shows measured MemTotal, pressure stall and the Used/Cached chart", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux"],
  });
  await openMemory(transport);
  // MemTotal appears in the subtitle and at the top of the chart's byte axis.
  expect(screen.getAllByText(formatBytes(LINUX_MEM_TOTAL_BYTES))).toHaveLength(
    2
  );
  expect(screen.getByLabelText("Pressure stall")).toHaveAccessibilityValue({
    text: /% · full .*%$/,
  });
  expect(screen.queryByLabelText("Compressed")).not.toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: /Used.*Cached files.*Free/ })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", { name: "Memory used and cached files" })
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole("adjustable", { name: "Memory pressure" })
  ).not.toBeOnTheScreen();
});

test("the host's reported memory series override its OS when choosing a chart", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux"],
  });
  const listHosts = transport.listHosts;
  jest.spyOn(transport, "listHosts").mockImplementation(async () =>
    (await listHosts()).map((host) => ({
      ...host,
      info: { ...host.info, os: "mac_os", mem_total_bytes: MEM_TOTAL_BYTES },
    }))
  );
  await openMemory(transport);
  expect(screen.getByText("24 GB unified")).toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", { name: "Memory used and cached files" })
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole("adjustable", { name: "Memory pressure" })
  ).not.toBeOnTheScreen();
});

test("empty Memory history shows missing peaks and notices for both charts", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "hostHistory").mockResolvedValue({
    status: "ok",
    data: {
      tier: "m1",
      bucket_ms: 60_000,
      complete_to_ms: now,
      series: [],
      gaps: [],
      events: [],
      stats: [],
      clamped: [],
    },
  });
  await openMemory(transport);
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(screen.getByText("No swap samples in this range")).toBeOnTheScreen();
  expect(screen.queryByText(/Drag to inspect/)).not.toBeOnTheScreen();
  expect(screen.getByLabelText("Peak used")).toHaveAccessibilityValue({
    text: MISSING,
  });
  expect(screen.getByLabelText("Peak swap")).toHaveAccessibilityValue({
    text: MISSING,
  });
});

test("Memory keeps recorded peaks while the live stream reconnects", async () => {
  const transport = createMockTransport({ autoTick: false });
  await openMemory(transport);
  expect(screen.getByLabelText("Used")).toHaveAccessibilityValue({
    text: /GB$/,
  });
  expect(screen.getByLabelText("Peak used")).toHaveAccessibilityValue({
    text: /GB$/,
  });
  await act(() => jest.advanceTimersByTimeAsync(3000));
  expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
  expect(screen.getByLabelText("Used")).toHaveAccessibilityValue({
    text: MISSING,
  });
  expect(screen.getByLabelText("Peak used")).toHaveAccessibilityValue({
    text: /GB$/,
  });
});

test.each(["warn", "critical"] as const)(
  "Memory shows a distinct alert for %s pressure",
  async (state) => {
    const transport = createMockTransport({ autoTick: false });
    const subscribe = transport.subscribeLive;
    jest
      .spyOn(transport, "subscribeLive")
      .mockImplementation((host, receive, options) => {
        let pressureIndex = -1;
        return subscribe(
          host,
          (message) => {
            if (message.kind === "layout")
              pressureIndex = message.series.findIndex(
                ({ metric }) => metric === "mem.pressure_level"
              );
            receive(
              message.kind === "frame"
                ? {
                    ...message,
                    held: message.held.map((value, index) =>
                      index === pressureIndex
                        ? METRIC_CODES["mem.pressure_level"][state]
                        : value
                    ),
                  }
                : message
            );
          },
          options
        );
      });
    await openMemory(transport);
    expect(
      screen.getByRole("alert", { name: `Pressure: ${state}` })
    ).toBeOnTheScreen();
  }
);

test("Memory tells the reader when the host is too old to answer history", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "hostHistory").mockResolvedValue({
    status: "error",
    error: { kind: "remote_unsupported", message: "No history feature" },
  });
  await openMemory(transport);
  expect(
    await screen.findByText(/^Update StatGlass on .+ to see history$/)
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeOnTheScreen();
  expect(screen.getByLabelText("Used")).toHaveAccessibilityValue({
    text: /GB$/,
  });
});
