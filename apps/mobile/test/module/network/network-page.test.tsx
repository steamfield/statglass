import { formatHistoryTime, formatRate, MISSING } from "@core/format";
import type { HostAddressesInfo } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import * as ReactNative from "react-native";
import { createGestureController } from "react-native-gesture-handler/jest-utils";
import { ModuleScreen } from "@/module";
import { Text } from "@/ui/text";

jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock")
);

const context = getMockContext({
  _layout: () => <Stack />,
  "[host]/[module]": ModuleScreen,
  elsewhere: () => <Text variant="body">Another screen</Text>,
});
const now = Date.UTC(2026, 10, 24, 15, 2);
const addresses: HostAddressesInfo = {
  interface: "en0",
  link_mbps: 143,
  ipv4: ["192.168.86.242"],
  ipv6: ["2001:db8::1"],
  public_ip: { state: "known", detail: { ip: "76.143.14.53" } },
  as_of_ms: now,
};
const header = "en0 · 143 Mb/s link · 192.168.86.242";

beforeEach(() => {
  jest.useFakeTimers({ now });
  mockAppState();
});
afterEach(() => {
  jest.useRealTimers();
});

function openNetwork(transport: MockTransport, host = MOCK_HOST_ID) {
  return renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${host}/network`)}
    />,
    { transport }
  );
}

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

test("the Network header shows the host's known IPv4 and public IP, with IPv6 on a second line", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: addresses,
  });
  await openNetwork(transport);
  expect(
    await screen.findByText(`${header} · Public 76.143.14.53`)
  ).toBeOnTheScreen();
  expect(screen.getByText("2001:db8::1")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledWith(MOCK_HOST_ID);
  await advance(3000);
  expect(read).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText("5m"));
  expect(read).toHaveBeenCalledTimes(1);
});

test("the Network header keeps every reported IPv4 and IPv6 address", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: {
      ...addresses,
      ipv4: ["192.168.86.242", "198.51.100.7"],
      ipv6: ["2001:db8::1", "2001:db8::2"],
    },
  });
  await openNetwork(transport);
  expect(
    await screen.findByText(`${header} · 198.51.100.7 · Public 76.143.14.53`)
  ).toBeOnTheScreen();
  expect(screen.getByText("2001:db8::1 · 2001:db8::2")).toBeOnTheScreen();
});

test("at accessibility text sizes both address captions appear before the range control", async () => {
  jest.spyOn(ReactNative, "useWindowDimensions").mockReturnValue({
    width: 402,
    height: 874,
    scale: 3,
    fontScale: 2.35,
  });
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: addresses,
  });
  await openNetwork(transport);
  const publicAddress = await screen.findByText(
    `${header} · Public 76.143.14.53`
  );
  const readingOrder = screen.getAllByText(
    /^(en0.*Public 76\.143\.14\.53|2001:db8::1|1h)$/
  );
  expect(readingOrder.indexOf(publicAddress)).toBe(0);
  expect(readingOrder.indexOf(screen.getByText("2001:db8::1"))).toBe(1);
  expect(readingOrder.indexOf(screen.getByText("1h"))).toBe(2);
  expect(screen.getByRole("header", { name: "Network" })).toBeOnTheScreen();
});

test("a pending public IP gets at most five polls, two seconds apart", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: { ...addresses, public_ip: { state: "pending" } },
  });
  await openNetwork(transport);
  expect(await screen.findByText(`${header} · Public …`)).toBeOnTheScreen();
  await advance(1999);
  expect(read).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(read).toHaveBeenCalledTimes(2);
  await advance(8000);
  expect(read).toHaveBeenCalledTimes(6);
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(6);
  expect(screen.getByText(`${header} · Public …`)).toBeOnTheScreen();
});

test("blur stops address polling, and refocus immediately refreshes the address", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest
    .spyOn(transport, "networkAddresses")
    .mockResolvedValueOnce({
      status: "ok",
      data: { ...addresses, public_ip: { state: "pending" } },
    })
    .mockResolvedValue({ status: "ok", data: addresses });
  await openNetwork(transport);
  await screen.findByText(`${header} · Public …`);
  await act(() => router.push("/elsewhere"));
  expect(await screen.findByText("Another screen")).toBeOnTheScreen();
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => router.back());
  expect(
    await screen.findByText(`${header} · Public 76.143.14.53`)
  ).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(2);
});

test("polling stops when a previously pending public IP resolves", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest
    .spyOn(transport, "networkAddresses")
    .mockResolvedValueOnce({
      status: "ok",
      data: { ...addresses, public_ip: { state: "pending" } },
    })
    .mockResolvedValue({ status: "ok", data: addresses });
  await openNetwork(transport);
  await screen.findByText(`${header} · Public …`);
  await advance(2000);
  expect(
    await screen.findByText(`${header} · Public 76.143.14.53`)
  ).toBeOnTheScreen();
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("an unavailable public IP includes the host's reason as a VoiceOver hint", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux-host"],
  });
  await openNetwork(transport, "remote-linux");
  const subtitle = await screen.findByText(/end0.*Public unavailable/);
  expect(screen.getByHintText("curl not installed")).toBe(subtitle);
});

test("an unknown public IP state shows the unavailable wording", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: { ...addresses, public_ip: { state: "unknown" } },
  });
  await openNetwork(transport);
  expect(
    await screen.findByText(`${header} · Public unavailable`)
  ).toBeOnTheScreen();
  expect(screen.queryByHintText("curl not installed")).not.toBeOnTheScreen();
});

test("a host without the address query falls back to the live interface and link", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["hosts-outdated"],
  });
  const read = jest.spyOn(transport, "networkAddresses");
  await openNetwork(transport, "remote-nas");
  await act(() => transport.tick());
  expect(await screen.findByText("end0 · 1.0 Gb/s link")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledWith("remote-nas");
  expect(screen.queryByText(/Public|2001:db8/)).not.toBeOnTheScreen();
});

test("an address query failure shows the typed recovery wording", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "error",
    error: { kind: "remote_busy", message: "timed out" },
  });
  await openNetwork(transport);
  expect(
    await screen.findByRole("alert", {
      name: "This host is busy or slow to answer, so its addresses can't be read now. Try again in a moment.",
    })
  ).toBeOnTheScreen();
});

test("a focused Network page reads addresses when its connecting host becomes ready", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux-host"],
  });
  transport.pushRemoteStatus("remote-linux", { state: "connecting" });
  const read = jest.spyOn(transport, "networkAddresses");
  await openNetwork(transport, "remote-linux");
  await screen.findByRole("tab", { name: "1h, History range" });
  expect(read).not.toHaveBeenCalled();
  await act(() =>
    transport.pushRemoteStatus("remote-linux", { state: "connected" })
  );
  expect(
    await screen.findByText(/end0.*192\.0\.2\.20.*Public unavailable/)
  ).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(1);
});

test("Network draws the two rates, direction ceilings and time ticks, and reads the chosen bucket", async () => {
  const transport = createMockTransport({ autoTick: false });
  const first = now - 60 * MINUTE_MS;
  jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async ({ series }) => ({
      status: "ok",
      data: {
        tier: "m1",
        bucket_ms: MINUTE_MS,
        complete_to_ms: now,
        series: series.map(({ metric, labels }) => {
          const rate = metric === "net.tx_total" ? 500_000 : 20_000_000;
          return {
            key: { metric, labels },
            hold_ms: 0,
            points: [{ t: first, min: rate, avg: rate, max: rate }],
          };
        }),
        gaps: [
          {
            start_ms: first + MINUTE_MS,
            end_ms: first + 2 * MINUTE_MS,
            module: "network",
            reason: "paused",
          },
        ],
        events: [],
        stats: [],
        clamped: [],
      },
    }));
  await openNetwork(transport);
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
  await fireEvent(screen.getByTestId("history-chart-plot"), "layout", {
    nativeEvent: { layout: { width: 270 } },
  });
  expect(
    await screen.findByLabelText(`↑ Upload · ${formatRate(500_000)}`)
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText(`↓ Download · ${formatRate(20_000_000)}`)
  ).toBeOnTheScreen();
  expect(screen.getByText("now")).toBeOnTheScreen();
  expect(screen.getByRole("note", { name: /paused/i })).toBeOnTheScreen();
  const chart = screen.getByRole("adjustable", {
    name: "Network history, upload above the line, download below",
  });
  const pan = createGestureController("history-pan");
  // The first bar takes 4.5 points. The right half still belongs to that bar.
  await act(() => {
    pan.begin({ x: 3.5 });
    pan.activate({ x: 3.5 });
  });
  expect(screen.getByText(`Upload · ${formatRate(500_000)}`)).toBeOnTheScreen();
  expect(
    screen.getByText(`Download · ${formatRate(20_000_000)}`)
  ).toBeOnTheScreen();
  await act(() => pan.end());
  await fireEvent(chart, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(chart).toHaveAccessibilityValue({
    text: `${formatHistoryTime(first, false)}, Upload ${formatRate(500_000)}, Download ${formatRate(20_000_000)}`,
  });
  await fireEvent(chart, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(screen.getByText("Upload · —")).toBeOnTheScreen();
  expect(screen.getByText("Download · —")).toBeOnTheScreen();
  expect(chart).toHaveAccessibilityValue({
    text: `${formatHistoryTime(first + MINUTE_MS, false)}, Upload No samples, Download No samples`,
  });
});

test("empty Network history explains that there are no samples to inspect", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "hostHistory").mockResolvedValue({
    status: "ok",
    data: {
      tier: "m1",
      bucket_ms: MINUTE_MS,
      complete_to_ms: now,
      series: [],
      gaps: [],
      stats: [],
      events: [],
      clamped: [],
    },
  });
  await openNetwork(transport);
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(screen.queryByText(/Drag to inspect/)).not.toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", {
      name: "Network history, upload above the line, download below",
    })
  ).toBeDisabled();
});

test("Network shows live throughput and interfaces and ranks processes by rate", async () => {
  const transport = createMockTransport({ autoTick: false });
  const interest = jest.spyOn(transport, "setProcessInterest");
  await openNetwork(transport);
  await waitFor(() =>
    expect(interest).toHaveBeenCalledWith(
      MOCK_HOST_ID,
      true,
      expect.objectContaining({ network: true }),
      expect.any(Number)
    )
  );
  await advance(1000);
  await act(() => transport.tick());
  expect(screen.getByLabelText("Download")).toHaveAccessibilityValue({
    text: /\/s$/,
  });
  expect(screen.getByLabelText("Upload")).toHaveAccessibilityValue({
    text: /\/s$/,
  });
  expect(screen.getByLabelText("Of link")).toHaveAccessibilityValue({
    text: /%$/,
  });
  expect(screen.getByRole("header", { name: "Interfaces" })).toBeOnTheScreen();
  expect(
    screen.getByLabelText(/^en0, Download .+ Upload .+/)
  ).toBeOnTheScreen();
  const apps = ["Safari", "com.docker.backend", "node", "Xcode", "Figma"];
  expect(
    screen.getAllByLabelText(/^(Safari|com\.docker\.backend|node|Xcode|Figma)$/)
  ).toEqual(apps.map((name) => screen.getByLabelText(name)));
  expect(
    screen.queryByText(/By app|Selection|Every process|Apps now/i)
  ).not.toBeOnTheScreen();
});

test("Network keeps visible history while the live readings reconnect", async () => {
  const transport = createMockTransport({ autoTick: false });
  await openNetwork(transport);
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
  await advance(1000);
  await act(() => transport.tick());
  expect(screen.getByLabelText("Download")).toHaveAccessibilityValue({
    text: /\/s$/,
  });
  await advance(3000);
  expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
  expect(screen.getByLabelText("Download")).toHaveAccessibilityValue({
    text: MISSING,
  });
  expect(
    screen.getByRole("adjustable", {
      name: "Network history, upload above the line, download below",
    })
  ).not.toBeDisabled();
});

test("Network reports busy history after bounded retry and offers a working Retry", async () => {
  const transport = createMockTransport({ autoTick: false });
  const hostHistory = transport.hostHistory;
  let busy = true;
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) =>
      busy
        ? {
            status: "error",
            error: { kind: "remote_busy", message: "Host busy" },
          }
        : hostHistory(request)
    );
  await openNetwork(transport);
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await advance(2000);
  expect(
    await screen.findByRole("alert", { name: /^StatGlass on .+ is busy$/ })
  ).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(3);
  busy = false;
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("alert", { name: /is busy$/ })
    ).not.toBeOnTheScreen()
  );
  expect(read).toHaveBeenCalledTimes(4);
});

test("a lower Network peak holds the previous scale for a minute", async () => {
  const transport = createMockTransport({ autoTick: false });
  let peak = 20e6;
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: {
        tier: "m1",
        bucket_ms: MINUTE_MS,
        complete_to_ms: request.to_ms ?? now,
        series: [
          {
            key: { metric: "net.rx_total", labels: [] },
            hold_ms: 0,
            points: [{ t: request.from_ms, min: peak, max: peak, avg: peak }],
          },
        ],
        gaps: [],
        events: [],
        stats: [],
        clamped: [],
      },
    }));
  await openNetwork(transport);
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
  const firstCeiling = `↓ Download · ${formatRate(peak)}`;
  expect(await screen.findByLabelText(firstCeiling)).toBeOnTheScreen();
  const chart = screen.getByRole("adjustable", {
    name: "Network history, upload above the line, download below",
  });
  const inspect = () =>
    fireEvent(chart, "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
  const oldReading = `Download · ${formatRate(peak)}`;
  await inspect();
  expect(screen.getByText(oldReading)).toBeOnTheScreen();
  peak = 5e6;
  await advance(MINUTE_MS);
  await waitFor(() =>
    expect(screen.queryByText(oldReading)).not.toBeOnTheScreen()
  );
  expect(read).toHaveBeenCalledTimes(2);
  await inspect();
  expect(screen.getByText(`Download · ${formatRate(peak)}`)).toBeOnTheScreen();
  expect(screen.getByLabelText(firstCeiling)).toBeOnTheScreen();
  await advance(MINUTE_MS);
  expect(
    await screen.findByLabelText(`↓ Download · ${formatRate(peak)}`)
  ).toBeOnTheScreen();
});
