import { formatHistoryTime, formatRate, MISSING } from "@core/format";
import type { HostAddressesInfo } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  layoutChart,
  MODULE_TEST_NOW as now,
  openModule,
  setModuleClock,
} from "@test/helpers/module-screen";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import * as ReactNative from "react-native";
import { createGestureController } from "react-native-gesture-handler/jest-utils";

const addresses: HostAddressesInfo = {
  interface: "en0",
  link_mbps: 143,
  ipv4: ["192.168.86.242"],
  ipv6: ["2001:db8::1"],
  public_ip: { state: "known", detail: { ip: "76.143.14.53" } },
  as_of_ms: now,
};
const header = "en0 · 143 Mb/s link";

/** React Native's jest mock reports font scale 2; address rows read at the default size. */
const textAt = (fontScale: number) =>
  jest
    .spyOn(ReactNative.Dimensions, "get")
    .mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });

beforeEach(() => {
  textAt(1);
});

beforeEach(setModuleClock);
afterEach(() => {
  jest.useRealTimers();
});

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

const publicIp = (value: string) =>
  waitFor(() =>
    expect(screen.getByLabelText("Public IP")).toHaveAccessibilityValue({
      text: value,
    })
  );

test("the Network header names the interface and link, and Addresses lists each address on its own row", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: addresses,
  });
  await openModule(transport, "network");
  expect(await screen.findByText(header)).toBeOnTheScreen();
  expect(screen.getByText("Addresses")).toBeOnTheScreen();
  expect(screen.getByLabelText("IPv4")).toHaveAccessibilityValue({
    text: "192.168.86.242",
  });
  expect(screen.getByLabelText("IPv6")).toHaveAccessibilityValue({
    text: "2001:db8::1",
  });
  await publicIp("76.143.14.53");
  expect(screen.queryByText(/Public 76/)).not.toBeOnTheScreen();
  expect(read).toHaveBeenCalledWith(MOCK_HOST_ID);
  await advance(3000);
  expect(read).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("tab", { name: "1h, History range" }));
  expect(read).toHaveBeenCalledTimes(1);
});

test("Addresses keeps every reported IPv4 and IPv6 address, IPv4 first and the public IP last", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: {
      ...addresses,
      ipv4: ["192.168.86.242", "198.51.100.7"],
      ipv6: ["2001:db8::1", "2001:db8::2"],
    },
  });
  await openModule(transport, "network");
  await publicIp("76.143.14.53");
  const values = screen
    .getAllByLabelText(/^(IPv4|IPv6|Public IP)$/)
    .map((row) => row.props.accessibilityValue?.text);
  expect(values).toEqual([
    "192.168.86.242",
    "198.51.100.7",
    "2001:db8::1",
    "2001:db8::2",
    "76.143.14.53",
  ]);
});

/** A stacked value sits under its label; an inline one is right-aligned in the trailing column. */
const stacked = (text: string) =>
  expect(screen.getByText(text)).not.toHaveStyle({ textAlign: "right" });

test("a full IPv6 address sits under its label instead of breaking in the value column", async () => {
  const transport = createMockTransport({ autoTick: false });
  const full = "2001:db8:85a3::8a2e:370:7334";
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: { ...addresses, ipv6: [full] },
  });
  await openModule(transport, "network");
  await publicIp("76.143.14.53");
  expect(screen.getByLabelText("IPv6")).toHaveAccessibilityValue({
    text: full,
  });
  stacked(full);
  expect(screen.getByText("192.168.86.242")).toHaveStyle({
    textAlign: "right",
  });
});

test("at accessibility text sizes every address sits under its label", async () => {
  textAt(2.35);
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: addresses,
  });
  await openModule(transport, "network");
  await publicIp("76.143.14.53");
  for (const address of ["192.168.86.242", "2001:db8::1", "76.143.14.53"])
    stacked(address);
});

test("a pending public IP gets at most five polls, two seconds apart", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: { ...addresses, public_ip: { state: "pending" } },
  });
  await openModule(transport, "network");
  await publicIp("Looking up…");
  await advance(1999);
  expect(read).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(read).toHaveBeenCalledTimes(2);
  await advance(8000);
  expect(read).toHaveBeenCalledTimes(6);
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(6);
  await publicIp("Looking up…");
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
  await openModule(transport, "network");
  await publicIp("Looking up…");
  await act(() => router.push("/elsewhere"));
  expect(await screen.findByText("Another screen")).toBeOnTheScreen();
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => router.back());
  await publicIp("76.143.14.53");
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
  await openModule(transport, "network");
  await publicIp("Looking up…");
  await advance(2000);
  await publicIp("76.143.14.53");
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("an unavailable public IP includes the host's reason as a VoiceOver hint", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux-host"],
  });
  await openModule(transport, "network", "remote-linux");
  await publicIp("Unavailable");
  expect(screen.getByHintText("curl not installed")).toBe(
    screen.getByLabelText("Public IP")
  );
});

test("an unknown public IP state shows the unavailable wording", async () => {
  const transport = createMockTransport({ autoTick: false });
  jest.spyOn(transport, "networkAddresses").mockResolvedValue({
    status: "ok",
    data: { ...addresses, public_ip: { state: "unknown" } },
  });
  await openModule(transport, "network");
  await publicIp("Unavailable");
  expect(screen.queryByHintText("curl not installed")).not.toBeOnTheScreen();
});

test("a host without the address query falls back to the live interface and link", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["hosts-outdated"],
  });
  const read = jest.spyOn(transport, "networkAddresses");
  await openModule(transport, "network", "remote-nas");
  await act(() => transport.tick());
  expect(await screen.findByText("end0 · 1.0 Gb/s link")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledWith("remote-nas");
  expect(screen.queryByText("Addresses")).not.toBeOnTheScreen();
});

test("an address query failure shows the typed recovery wording", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.failNext("networkAddresses", {
    kind: "remote_busy",
    message: "timed out",
  });
  await openModule(transport, "network");
  expect(
    await screen.findByRole("alert", {
      name: "This host is busy or slow to answer, so its addresses can't be read now. Try again in a moment.",
    })
  ).toBeOnTheScreen();
  expect(screen.queryByText("Addresses")).not.toBeOnTheScreen();
});

test("a focused Network page reads addresses when its connecting host becomes ready", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux-host"],
  });
  transport.pushRemoteStatus("remote-linux", { state: "connecting" });
  const read = jest.spyOn(transport, "networkAddresses");
  await openModule(transport, "network", "remote-linux");
  await screen.findByRole("tab", { name: "15m, History range" });
  expect(read).not.toHaveBeenCalled();
  await act(() =>
    transport.pushRemoteStatus("remote-linux", { state: "connected" })
  );
  await waitFor(() =>
    expect(screen.getByLabelText("IPv4")).toHaveAccessibilityValue({
      text: "192.0.2.20",
    })
  );
  expect(read).toHaveBeenCalledTimes(1);
});

test("Network draws the two rates, direction ceilings and time ticks, and reads the chosen bucket", async () => {
  const transport = createMockTransport({ autoTick: false });
  const first = now - 15 * MINUTE_MS;
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
  await openModule(transport, "network");
  await layoutChart();
  await layoutChart("history-chart-plot", 270);
  expect(
    await screen.findByText(`↑ Upload · ${formatRate(500_000)}`)
  ).toBeOnTheScreen();
  expect(
    screen.getByText(`↓ Download · ${formatRate(20_000_000)}`)
  ).toBeOnTheScreen();
  expect(screen.getByText("now")).toBeOnTheScreen();
  expect(screen.getByRole("note", { name: /paused/i })).toBeOnTheScreen();
  const chart = screen.getByRole("adjustable", {
    name: "Network history, upload above the line, download below",
  });
  const pan = createGestureController("history-pan");
  // The first of 15 bars takes 18 points. The right half still belongs to it.
  await act(() => {
    pan.begin({ x: 14 });
    pan.activate({ x: 14 });
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
  await openModule(transport, "network");
  await layoutChart();
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(screen.queryByText(/Drag to inspect/)).not.toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", {
      name: "Network history, upload above the line, download below",
    })
  ).toBeDisabled();
});

test("Network shows the host's range totals and how long a short range was measured", async () => {
  const transport = createMockTransport({ autoTick: false });
  const total = (metric: string, integral: number, measured_ms: number) => ({
    key: { metric, labels: [] },
    avg: 1,
    peak: 2,
    measured_ms,
    integral,
  });
  jest.spyOn(transport, "hostHistory").mockResolvedValue({
    status: "ok",
    data: {
      tier: "m1",
      bucket_ms: MINUTE_MS,
      complete_to_ms: now,
      series: [],
      gaps: [],
      stats: [
        total("net.rx_total", 1.5e9, 11 * MINUTE_MS),
        total("net.tx_total", 2e8, 400 * 24 * 60 * MINUTE_MS),
      ],
      events: [],
      clamped: [],
    },
  });
  await openModule(transport, "network");
  await layoutChart();
  await waitFor(() =>
    expect(screen.getByLabelText(/^↓ Downloaded · /)).toHaveAccessibilityValue({
      text: /GB in 11 min$/,
    })
  );
  expect(screen.getByLabelText(/^↑ Uploaded · /)).toHaveAccessibilityValue({
    text: /^[\d.]+ MB$/,
  });
});

test("Network shows live throughput and interfaces and ranks processes by rate", async () => {
  const transport = createMockTransport({ autoTick: false });
  const interest = jest.spyOn(transport, "setProcessInterest");
  await openModule(transport, "network");
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
  await openModule(transport, "network");
  await layoutChart();
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
  const read = jest.spyOn(transport, "hostHistory");
  for (let attempt = 0; attempt < 3; attempt++)
    transport.failNext("hostHistory", {
      kind: "remote_busy",
      message: "Host busy",
    });
  await openModule(transport, "network");
  await layoutChart();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await advance(2000);
  expect(
    await screen.findByRole("alert", { name: /^StatGlass on .+ is busy$/ })
  ).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(3);
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
  await openModule(transport, "network");
  await layoutChart();
  const firstCeiling = `↓ Download · ${formatRate(peak)}`;
  expect(await screen.findByText(firstCeiling)).toBeOnTheScreen();
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
  expect(screen.getByText(firstCeiling)).toBeOnTheScreen();
  await advance(MINUTE_MS);
  expect(
    await screen.findByText(`↓ Download · ${formatRate(peak)}`)
  ).toBeOnTheScreen();
});

test("Network asks for one bar per six points of plot, like the desktop's narrow mirror charts", async () => {
  const transport = createMockTransport({ autoTick: false });
  const history = jest.spyOn(transport, "hostHistory");
  await openModule(transport, "network");
  await layoutChart();
  await waitFor(() =>
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({ max_points: 50 })
    )
  );
  expect(history).not.toHaveBeenCalledWith(
    expect.objectContaining({ max_points: 120 })
  );
});
