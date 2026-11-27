import { chartLabel } from "@core/chart-label";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import {
  PHONE_CLOCK_OFFSET_MS,
  PHONE_LAST_SEEN_MS,
  phoneCommandFailures,
} from "@core/mock/phone-errors";
import { createMockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, router, Stack, usePathname } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { useState } from "react";
import {
  AccessibilityInfo,
  Dimensions,
  Pressable,
  Text,
  View,
} from "react-native";
import { useHostLiveSubscription } from "@/data/live";
import { PHONE_LIVE_SERIES } from "@/data/live-series";
import { useCompactStream } from "@/data/live-stream";
import { HostScreen } from "@/host";

const context = getMockContext({
  _layout: function Layout() {
    const pathname = usePathname();
    return (
      <>
        <Text accessibilityLabel="Current route">{pathname}</Text>
        <Stack />
      </>
    );
  },
  "(hosts)/index": () => <View />,
  "(hosts)/[host]/index": HostScreen,
  "(hosts)/[host]/[module]": () => <View />,
});

const now = Date.UTC(2026, 10, 24, 15, 2);
let changeAppState: ReturnType<typeof mockAppState>;

beforeEach(() => {
  jest.useFakeTimers({ now });
  changeAppState = mockAppState();
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
  jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockReturnValue({ remove: jest.fn() });
});

afterEach(() => {
  jest.useRealTimers();
});

test("paging updates the native title and switches the focused subscription and URL", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const hosts = await transport.listHosts();
  const linux = hosts.find((host) => host.info.os === "linux");
  if (!linux) throw new Error("The demo needs a Linux host");

  const subscribe = jest.spyOn(transport, "subscribeLive");
  const view = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    {
      transport,
      settings: {
        hostOrder: [MOCK_HOST_ID, linux.id],
        removed: hosts
          .filter(({ id }) => id !== MOCK_HOST_ID && id !== linux.id)
          .map(({ id }) => id),
      },
    }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  const headerTitles = () =>
    view.container
      .queryAll(
        ({ type, props }) =>
          type === "RNSScreenStackHeaderConfig" && props.largeTitle
      )
      .map(({ props }) => props.title);
  expect(headerTitles()).toContain("MacBook Pro");
  expect(screen.queryByText("MacBook Pro")).toBeNull();
  // UIKit follows the first scroll view when collapsing the large title.
  const [outerScroll] = view.container.queryAll(
    ({ type }) => type === "RCTScrollView"
  );
  expect(outerScroll?.parent?.type).toBe("RNSScreenContentWrapper");
  expect(
    outerScroll?.queryAll(
      ({ props }) => props.accessibilityLabel === "Hosts pager"
    )
  ).toHaveLength(1);
  expect(transport.subscriberCount()).toBe(1);
  expect(subscribe.mock.lastCall).toEqual([
    MOCK_HOST_ID,
    expect.any(Function),
    { series: PHONE_LIVE_SERIES, backfillMs: 300_000 },
  ]);

  await fireEvent(screen.getByLabelText("Hosts pager"), "momentumScrollEnd", {
    nativeEvent: { contentOffset: { x: Dimensions.get("window").width, y: 0 } },
  });
  expect(headerTitles()).toContain(linux.display_name);
  expect(screen.queryByText(linux.display_name)).toBeNull();
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
});

test("pushing a module stops the host stream and going back resumes it", async () => {
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
});

test("unmounting a focused host releases its subscription", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const view = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await view.unmount();
  expect(transport.subscriberCount()).toBe(0);
});

test("a host that never sends a frame shows Reconnecting after three periods", async () => {
  const transport = createMockTransport({
    scenarios: ["stale"],
    autoTick: false,
    historyRows: 2,
  });
  try {
    await renderWithProviders(
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${MOCK_HOST_ID}`)}
      />,
      { transport }
    );
    expect(await screen.findByText("Connecting")).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText("Connecting")).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
  } finally {
    transport.dispose();
  }
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
  // The stale scenario is fixed at creation; this host stops and then resumes.
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
    transport.pushRemoteStatus(host, {
      state: "offline",
      last_seen_ms: PHONE_LAST_SEEN_MS,
      clock_offset_ms: PHONE_CLOCK_OFFSET_MS,
    })
  );
  const offline = "Offline since 14:02";
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

  await changeAppState("background");
  await act(() => jest.advanceTimersByTimeAsync(510));
  expect(transport.subscriberCount()).toBe(0);
  await changeAppState("active");
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(() => jest.advanceTimersByTimeAsync(510));
  await act(() => transport.tick());
  expect(await screen.findByText("Live · 1s")).toBeOnTheScreen();
  expect(transport.subscriberCount()).toBe(1);
  await changeAppState("inactive");
  expect(transport.subscriberCount()).toBe(0);
  transport.setDisplayIdle(true);
  await changeAppState("active");
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

test("a terminal remote authentication failure names the problem and stops retrying", async () => {
  const host = "phone-no-longer-authorized";
  const transport = createMockTransport({
    scenarios: ["phone-errors"],
    historyRows: 2,
  });
  const removed = (await transport.listHosts())
    .filter(({ id }) => id !== host)
    .map(({ id }) => id);
  transport.failNext("subscribeLive", phoneCommandFailures.revokedKey);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const subscribe = jest.spyOn(transport, "subscribeLive");
  const view = await renderWithProviders(
    <ExpoRoot context={context} location={new URL(`statglass:///${host}`)} />,
    { transport, settings: { removed } }
  );
  try {
    expect(
      await screen.findByText(
        "This iPhone is no longer authorized on no-longer-authorized"
      )
    ).toBeOnTheScreen();
    const attempts = subscribe.mock.calls.length;
    await act(() => jest.advanceTimersByTimeAsync(15_000));
    expect(subscribe).toHaveBeenCalledTimes(attempts);
    expect(log.mock.calls).toEqual([
      [
        "[live] subscribe failed",
        { hostId: host, reason: phoneCommandFailures.revokedKey.message },
      ],
    ]);
  } finally {
    await view.unmount();
    transport.dispose();
  }
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
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
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
        "Couldn’t read connection status. Status endpoint unavailable.",
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

test("a connected compact stream shows its cellular cadence in the pill", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: true,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected"
  );
  if (!remote) throw new Error("Expected a connected remote");
  transport.pushRemoteStatus(remote.config.id, { demand: "compact" });
  const removed = (await transport.listHosts())
    .filter(({ id }) => id !== remote.config.id)
    .map(({ id }) => id);
  const view = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${remote.config.id}`)}
    />,
    { transport, settings: { removed } }
  );
  try {
    expect(
      await screen.findByText("Every 5 s on cellular", {}, { timeout: 2000 })
    ).toBeOnTheScreen();
    expect(screen.queryByText(/^Live ·/)).toBeNull();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("repeated transient subscription failures log once per reason before recovery", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = jest.spyOn(transport, "subscribeLive");
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const { transientNetwork, networkChanged } = phoneCommandFailures;
  for (const error of [
    transientNetwork,
    transientNetwork,
    networkChanged,
    transientNetwork,
  ]) {
    transport.failNext("subscribeLive", error);
  }
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
  const spoken = (figure: string) =>
    chartLabel({
      subject: "CPU",
      spanMs: 900_000,
      now: `now ${figure}`,
    });
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
  expect(await screen.findByText(spoken("10%"))).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Change CPU reading" })
  );
  expect(screen.getByText(spoken("10%"))).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(10_000));
  await act(() => transport.tick());
  expect(await screen.findByText(spoken("20%"))).toBeOnTheScreen();
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
