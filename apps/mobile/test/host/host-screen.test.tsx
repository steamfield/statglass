import { formatClock } from "@core/format";
import type { LiveMsg } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { POPOVER_CARD_SERIES } from "@core/popover/series";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, router, Stack, usePathname } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  DeviceEventEmitter,
  Dimensions,
  Pressable,
  Text,
  View,
} from "react-native";
import * as CpuCard from "@/cards/cpu-card";
import * as GpuCard from "@/cards/gpu-card";
import { useHostLiveSubscription } from "@/data/live";
import { useCompactStream } from "@/data/live-stream";
import { HostScreen } from "@/host";
import { motionDurations } from "@/theme.generated";
import * as PhoneText from "@/ui/text";

const context = getMockContext({
  _layout: function Layout() {
    const pathname = usePathname();
    return (
      <>
        <Text accessibilityLabel="Current route">{pathname}</Text>
        <Stack screenOptions={{ headerShown: false }} />
      </>
    );
  },
  "(hosts)/_layout": () => <Stack screenOptions={{ headerShown: false }} />,
  "(hosts)/index": () => <View />,
  "(hosts)/[host]/index": HostScreen,
  "(hosts)/[host]/[module]": () => <View />,
});

const now = Date.UTC(2026, 10, 24, 15, 2);
const initialAppState = AppState.currentState;
let appStateListener: (state: "background" | "active" | "inactive") => void;

beforeEach(() => {
  jest.useFakeTimers({ now });
  AppState.currentState = "active";
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
  jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockReturnValue({ remove: jest.fn() });
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((type, listener) => {
      if (type === "change") appStateListener = listener;
      return { remove: jest.fn() };
    });
});

afterEach(() => {
  AppState.currentState = initialAppState;
  jest.useRealTimers();
});

test("paging moves the URL and switches the focused subscription; blur and unmount stop it", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const linux = (await transport.listHosts()).find(
    (host) => host.info.os === "linux"
  );
  if (!linux) throw new Error("The demo needs a Linux host");

  const subscribe = jest.spyOn(transport, "subscribeLive");
  const screenView = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    {
      transport,
      settings: { hostOrder: [MOCK_HOST_ID, linux.id] },
    }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  expect(transport.subscriberCount()).toBe(1);
  expect(subscribe.mock.lastCall).toEqual([
    MOCK_HOST_ID,
    expect.any(Function),
    { series: POPOVER_CARD_SERIES, backfillMs: 60_000 },
  ]);

  await fireEvent(screen.getByLabelText("Hosts pager"), "momentumScrollEnd", {
    nativeEvent: { contentOffset: { x: Dimensions.get("window").width, y: 0 } },
  });
  expect(
    await screen.findByRole("header", { name: linux.display_name })
  ).toBeOnTheScreen();
  expect(screen.getByLabelText("Current route")).toHaveTextContent(
    `/${linux.id}`
  );
  expect(subscribe.mock.lastCall?.[0]).toBe(linux.id);
  expect(transport.subscriberCount()).toBe(0);
  await fireEvent(screen.getByLabelText("Hosts pager"), "momentumScrollEnd", {
    nativeEvent: { contentOffset: { x: 0, y: 0 } },
  });
  expect(screen.getByLabelText("Current route")).toHaveTextContent(
    `/${MOCK_HOST_ID}`
  );
  expect(transport.subscriberCount()).toBe(1);
  await act(() =>
    router.push({
      pathname: "/(hosts)/[host]/[module]",
      params: { host: MOCK_HOST_ID, module: "cpu" },
    })
  );
  expect(transport.subscriberCount()).toBe(0);
  await act(() => router.back());
  expect(screen.getByLabelText("Current route")).toHaveTextContent(
    `/${MOCK_HOST_ID}`
  );
  expect(transport.subscriberCount()).toBe(1);
  expect(await screen.findByText("Reconnecting")).toBeOnTheScreen();
  expect(screen.getByLabelText("Module cards")).toHaveStyle({ opacity: 0.5 });
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  await screenView.unmount();
  expect(transport.subscriberCount()).toBe(0);
});

test("shows frame age, announces stale and offline reads, and undims after recovery", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: true,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected" && status.route === "lan"
  );
  if (!remote) throw new Error("The demo needs a connected LAN host");
  const host = remote.config.id;
  let deliverFrames = true;
  const subscribeLive = transport.subscribeLive;
  jest
    .spyOn(transport, "subscribeLive")
    .mockImplementation((hostId, receive, options) =>
      subscribeLive(
        hostId,
        (message) => {
          if (message.kind !== "frame" || deliverFrames) receive(message);
        },
        options
      )
    );
  const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  const view = await renderWithProviders(
    <ExpoRoot context={context} location={new URL(`statglass:///${host}`)} />,
    { transport }
  );

  expect(
    await screen.findByText("Live · LAN 1s", {}, { timeout: 2000 })
  ).toBeOnTheScreen();
  const cards = screen.getByLabelText("Module cards");
  expect(cards).toHaveStyle({ opacity: 1 });
  deliverFrames = false;

  await act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByText("Live · LAN 2s")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
  expect(cards).toHaveStyle({ opacity: 0.5 });
  expect(announce).toHaveBeenCalledWith("Reconnecting");

  await act(() =>
    transport.pushRemoteStatus(host, { state: "offline", last_seen_ms: now })
  );
  const offline = `Offline since ${formatClock(now)}`;
  expect(await screen.findByText(offline)).toBeOnTheScreen();
  expect(announce).toHaveBeenCalledWith(offline);
  expect(cards).toHaveStyle({ opacity: 0.5 });

  await act(() =>
    transport.pushRemoteStatus(host, { state: "connected", route: "tailscale" })
  );
  deliverFrames = true;
  expect(
    await screen.findByText("Live · Tailscale 1s", {}, { timeout: 2000 })
  ).toBeOnTheScreen();
  expect(cards).toHaveStyle({ opacity: 1 });
  await view.unmount();
  transport.dispose();
});

test("backgrounding during setup cleans up a late stream and foregrounding subscribes again", async () => {
  const transport = createMockTransport({
    autoTick: false,
    latencyMs: 500,
    historyRows: 2,
  });
  const subscribe = jest.spyOn(transport, "subscribeLive");
  const screenView = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

  await act(() => appStateListener("background"));
  await act(() => jest.advanceTimersByTimeAsync(510));
  expect(transport.subscriberCount()).toBe(0);
  await act(() => appStateListener("active"));
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(() => jest.advanceTimersByTimeAsync(510));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  expect(transport.subscriberCount()).toBe(1);
  await act(() => appStateListener("inactive"));
  expect(transport.subscriberCount()).toBe(0);
  transport.setDisplayIdle(true);
  await act(() => appStateListener("active"));
  expect(await screen.findByText("Display asleep")).toBeOnTheScreen();
  await screenView.unmount();
});

test("a remote source replacement resubscribes even before the old source sends a frame", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "offline"
  );
  if (!remote) throw new Error("The demo needs an offline remote");
  const subscribe = jest.spyOn(transport, "subscribeLive");
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${remote.config.id}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
  await act(() => transport.emitHostsChanged());
  expect(subscribe).toHaveBeenCalledTimes(1);
  await act(() =>
    transport.updateRemoteHost({ ...remote.config, name: "Renamed remote" })
  );
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(subscribe.mock.lastCall?.[0]).toBe(remote.config.id);
});

test("a terminal subscribe error names the failure and stops retrying", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = jest.spyOn(transport, "subscribeLive").mockResolvedValue({
    info: {
      status: "error",
      error: { kind: "unknown_host", host: MOCK_HOST_ID },
    },
    unsubscribe: () => {},
  });
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  expect(
    await screen.findByText("This host is no longer in your host list.")
  ).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(15_000));
  expect(subscribe).toHaveBeenCalledTimes(1);
});

test("a failed remote status read dims the remote while the local host can still read Live", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: true,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected"
  );
  if (!remote) throw new Error("The demo needs a connected host");
  jest.spyOn(transport, "listRemoteHosts").mockRejectedValue({
    kind: "remote_unreachable",
    message: "Network unavailable",
  });
  const view = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${remote.config.id}`)}
    />,
    { transport, settings: { hostOrder: [remote.config.id, MOCK_HOST_ID] } }
  );
  try {
    expect(
      await screen.findByText(
        "This host isn't connected, so its connection status can't be read now.",
        {},
        { timeout: 2000 }
      )
    ).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTimeAsync(1000));
    expect(screen.queryByText(/^Live/)).not.toBeOnTheScreen();
    expect(screen.getByLabelText("Module cards")).toHaveStyle({ opacity: 0.5 });
    await fireEvent(screen.getByLabelText("Hosts pager"), "momentumScrollEnd", {
      nativeEvent: {
        contentOffset: { x: Dimensions.get("window").width, y: 0 },
      },
    });
    await act(() => transport.tick());
    expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("a frame that changes CPU readouts leaves the host heading and unchanged GPU card alone", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = transport.subscribeLive;
  const messages: LiveMsg[] = [];
  jest
    .spyOn(transport, "subscribeLive")
    .mockImplementation((host, receive, options) =>
      subscribe(
        host,
        (message) => {
          messages.push(message);
          receive(message);
        },
        options
      )
    );
  const text = jest.spyOn(PhoneText, "Text");
  const cpu = jest.spyOn(CpuCard, "CpuCard");
  const gpu = jest.spyOn(GpuCard, "GpuCard");
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  const frame = messages.find((message) => message.kind === "frame");
  const layout = messages.find(
    (message) =>
      message.kind === "layout" && message.layout_no === frame?.layout_no
  );
  if (!frame || layout?.kind !== "layout")
    throw new Error("The demo needs a frame and its layout");
  const total = layout.series.findIndex(({ metric }) => metric === "cpu.total");
  if (total < 0) throw new Error("The frame needs a CPU total");
  expect(gpu).toHaveBeenCalled();
  text.mockClear();
  cpu.mockClear();
  gpu.mockClear();
  await act(() => jest.advanceTimersByTimeAsync(1));
  await act(() =>
    transport.push({
      ...frame,
      held: frame.held.map((value, index) =>
        index === total ? (value ?? 0) + 1 : value
      ),
    })
  );
  expect(cpu).toHaveBeenCalledTimes(1);
  expect(text.mock.calls.some(([props]) => props.role === "largeTitle")).toBe(
    false
  );
  expect(gpu).not.toHaveBeenCalled();
});

test("motion events that leave the effective preference unchanged leave cards alone", async () => {
  jest
    .mocked(AccessibilityInfo.addEventListener)
    .mockImplementation((event, listener) =>
      DeviceEventEmitter.addListener(event, listener)
    );
  const cpu = jest.spyOn(CpuCard, "CpuCard");
  const gpu = jest.spyOn(GpuCard, "GpuCard");
  const text = jest.spyOn(PhoneText, "Text");
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  expect(cpu).toHaveBeenCalled();
  expect(gpu).toHaveBeenCalled();
  cpu.mockClear();
  gpu.mockClear();
  text.mockClear();

  await act(() => DeviceEventEmitter.emit("reduceMotionChanged", true));
  await act(() =>
    DeviceEventEmitter.emit("mockLowPowerModeChanged", { lowPowerMode: true })
  );
  await act(() => DeviceEventEmitter.emit("reduceMotionChanged", false));

  expect(cpu).not.toHaveBeenCalled();
  expect(gpu).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
});

test("repeated transient subscription failures log once per reason before recovery", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const originalSubscribe = transport.subscribeLive;
  const subscribe = jest.spyOn(transport, "subscribeLive");
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  for (const reason of [
    "Network unavailable",
    "Network unavailable",
    "Network changed",
    "Network unavailable",
  ]) {
    subscribe.mockRejectedValueOnce(new Error(reason));
  }
  subscribe.mockImplementation(originalSubscribe);
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
  await act(() => jest.advanceTimersByTimeAsync(8500));
  expect(transport.subscriberCount()).toBe(1);
  expect(log.mock.calls.map(([, details]) => details)).toEqual([
    { hostId: MOCK_HOST_ID, reason: "Network unavailable" },
    { hostId: MOCK_HOST_ID, reason: "Network changed" },
  ]);
});

test("the watchdog logs why it replaces a silent subscription", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const log = jest.spyOn(console, "warn").mockImplementation(() => {});
  const subscribe = jest.spyOn(transport, "subscribeLive");
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  await act(() => jest.advanceTimersByTimeAsync(6000));
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      hostId: MOCK_HOST_ID,
      reason: "No live frames",
    })
  );
});

function ChartLabelScene() {
  const [value, setValue] = useState("10%");
  useHostLiveSubscription(MOCK_HOST_ID);
  const stream = useCompactStream(MOCK_HOST_ID, {
    seriesKey: "cpu.total",
    accent: "cpu",
    subject: "CPU",
    now: value,
    height: 52,
  });
  return (
    <>
      <Text>{stream?.ariaLabel}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Change CPU reading"
        onPress={() => setValue("20%")}
      />
    </>
  );
}

test("the compact chart keeps its spoken reading for ten seconds", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  await renderWithProviders(
    <ExpoRoot
      context={getMockContext({ index: ChartLabelScene })}
      location={new URL("statglass:///")}
    />,
    { transport }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  expect(
    await screen.findByText("CPU, last 60 seconds, now 10%")
  ).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Change CPU reading" })
  );
  expect(screen.getByText("CPU, last 60 seconds, now 10%")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(10_000));
  await act(() => transport.tick());
  expect(
    await screen.findByText("CPU, last 60 seconds, now 20%")
  ).toBeOnTheScreen();
});

test("when motion is enabled, stale cards request the fast fade to half opacity", async () => {
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(false);
  const animate = jest
    .spyOn(Animated, "timing")
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(3000));
  expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
  expect(animate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      toValue: 0.5,
      duration: motionDurations.fast,
      useNativeDriver: true,
    })
  );
});

test("a removed host URL shows the missing host state and opens no stream", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = jest.spyOn(transport, "subscribeLive");
  await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    {
      transport,
      settings: { removed: [MOCK_HOST_ID] },
    }
  );
  expect(
    await screen.findByText("This host is no longer in your host list.")
  ).toBeOnTheScreen();
  expect(subscribe).not.toHaveBeenCalled();
});
