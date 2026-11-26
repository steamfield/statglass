import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { phoneCommandFailures } from "@core/mock/phone-errors";
import { createMockTransport } from "@core/mock-transport";
import { beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { AccessibilityInfo, View } from "react-native";
import { HostScreen } from "@/host";

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "(hosts)/_layout": () => <Stack screenOptions={{ headerShown: false }} />,
  "(hosts)/index": () => <View />,
  "(hosts)/[host]/index": HostScreen,
  "(hosts)/[host]/[module]": () => <View />,
});

beforeEach(() => {
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
});

async function advance(ms: number) {
  await act(() => jest.advanceTimersByTimeAsync(ms));
}

test("a silent foreground stream goes stale and recovers on a fresh frame", async () => {
  jest.useFakeTimers();
  mockAppState();
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const subscribe = jest.spyOn(transport, "subscribeLive");
  try {
    const view = await renderWithProviders(
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${MOCK_HOST_ID}`)}
      />,
      { transport }
    );
    try {
      await waitFor(() => expect(transport.subscriberCount()).toBe(1));
      expect(screen.getByText("Connecting")).toBeOnTheScreen();
      await advance(1000);
      await act(() => transport.tick());
      expect(screen.getByText("Live · 1s")).toBeOnTheScreen();

      await advance(2999);
      expect(screen.queryByText("Reconnecting")).not.toBeOnTheScreen();
      await advance(1);
      expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
      expect(screen.getByLabelText("Module cards")).toHaveStyle({
        opacity: 0.5,
      });
      expect(subscribe).toHaveBeenCalledTimes(1);
      await advance(3000);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Reconnecting")).toBeOnTheScreen();

      await act(() => transport.tick());
      expect(screen.getByText("Live · 1s")).toBeOnTheScreen();
      expect(screen.getByLabelText("Module cards")).toHaveStyle({ opacity: 1 });
    } finally {
      await view.unmount();
    }
  } finally {
    transport.dispose();
    warn.mockRestore();
    jest.useRealTimers();
  }
});

test("background and blur release the stream until the focused app is active", async () => {
  jest.useFakeTimers();
  const appState = mockAppState();
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = jest.spyOn(transport, "subscribeLive");
  try {
    await appState("background");
    const view = await renderWithProviders(
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${MOCK_HOST_ID}`)}
      />,
      { transport }
    );
    try {
      await advance(100);
      expect(subscribe).toHaveBeenCalledTimes(0);
      await appState("active");
      await waitFor(() => expect(transport.subscriberCount()).toBe(1));
      await act(() => transport.tick());
      expect(screen.getByText("Live · 1s")).toBeOnTheScreen();
      await appState("background");
      expect(transport.subscriberCount()).toBe(0);
      await advance(10_000);
      expect(subscribe).toHaveBeenCalledTimes(1);

      await act(() =>
        router.push({
          pathname: "/(hosts)/[host]/[module]",
          params: { host: MOCK_HOST_ID, module: "cpu" },
        })
      );
      await appState("active");
      await advance(60_000);
      expect(subscribe).toHaveBeenCalledTimes(1);
      await act(() => router.back());
      await waitFor(() => expect(transport.subscriberCount()).toBe(1));
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
      await act(() => transport.tick());
      expect(screen.getByText("Live · 1s")).toBeOnTheScreen();
    } finally {
      await view.unmount();
    }
    expect(transport.subscriberCount()).toBe(0);
  } finally {
    transport.dispose();
    jest.useRealTimers();
  }
});

test("a reply that arrives in the background is released before one foreground subscription", async () => {
  jest.useFakeTimers();
  const appState = mockAppState();
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const original = transport.subscribeLive;
  let reply: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    reply = resolve;
  });
  const subscribe = jest
    .spyOn(transport, "subscribeLive")
    .mockImplementationOnce(async (...args) => {
      await pending;
      return original(...args);
    });
  try {
    const view = await renderWithProviders(
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${MOCK_HOST_ID}`)}
      />,
      { transport }
    );
    try {
      await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
      await appState("background");
      await act(async () => reply?.());
      expect(transport.subscriberCount()).toBe(0);
      await advance(10_000);
      expect(subscribe).toHaveBeenCalledTimes(1);
      await appState("active");
      await waitFor(() => expect(transport.subscriberCount()).toBe(1));
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      await view.unmount();
    }
  } finally {
    transport.dispose();
    jest.useRealTimers();
  }
});

test("registration leaves a backgrounded phone unsubscribed until it is active", async () => {
  jest.useFakeTimers();
  const appState = mockAppState();
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["hosts-dashboard"],
  });
  try {
    const remotes = await transport.listRemoteHosts();
    const remote = remotes.find(({ status }) => status.state === "connected");
    const other = remotes.find(({ config }) => config.id !== remote?.config.id);
    if (!remote || !other) throw new Error("Missing remote fixtures");
    const subscribe = jest.spyOn(transport, "subscribeLive");
    const view = await renderWithProviders(
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${remote.config.id}`)}
      />,
      { transport }
    );
    try {
      await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
      await act(() =>
        transport.updateRemoteHost({
          ...other.config,
          name: "Renamed other host",
        })
      );
      expect(subscribe).toHaveBeenCalledTimes(1);
      await appState("background");
      await act(() =>
        transport.updateRemoteHost({
          ...remote.config,
          name: "Renamed selected host",
        })
      );
      await advance(1000);
      expect(subscribe).toHaveBeenCalledTimes(1);

      await appState("active");
      await advance(1000);
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      await view.unmount();
    }
  } finally {
    transport.dispose();
    jest.useRealTimers();
  }
});

test("a connection-status read failure is shown as a local error", async () => {
  jest.useFakeTimers();
  mockAppState();
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["hosts-dashboard"],
  });
  try {
    const remote = (await transport.listRemoteHosts()).find(
      ({ status }) => status.state === "connected"
    );
    if (!remote) throw new Error("Missing connected remote fixture");
    const readStatus = jest.spyOn(transport, "listRemoteHosts");
    transport.failNext("listRemoteHosts", phoneCommandFailures.status);
    transport.failNext("listRemoteHosts", phoneCommandFailures.status);
    const view = await renderWithProviders(
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${remote.config.id}`)}
      />,
      { transport }
    );
    try {
      await waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));
      await advance(1100);
      expect(
        screen.getByText("Couldn’t read connection status. Network unavailable")
      ).toBeOnTheScreen();
    } finally {
      await view.unmount();
    }
  } finally {
    transport.dispose();
    jest.useRealTimers();
  }
});

test("a recovered host shows Reconnecting while its stream is still in backoff", async () => {
  jest.useFakeTimers();
  mockAppState();
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["hosts-dashboard"],
  });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const remote = (await transport.listRemoteHosts()).find(
      ({ status }) => status.state === "connected"
    );
    if (!remote) throw new Error("Missing connected remote fixture");
    const host = remote.config.id;
    transport.pushRemoteStatus(host, {
      state: "error",
      failure_kind: "authentication",
      last_seen_ms: null,
    });
    const listenForStatus = jest.spyOn(transport, "onRemoteHostsChanged");
    const subscribe = jest.spyOn(transport, "subscribeLive");
    const busy = { kind: "remote_busy", message: "Busy" } as const;
    transport.failNext("subscribeLive", busy);
    transport.failNext("subscribeLive", busy);
    const view = await renderWithProviders(
      <ExpoRoot context={context} location={new URL(`statglass:///${host}`)} />,
      { transport }
    );
    try {
      expect(
        await screen.findByText("Key not accepted by sshd")
      ).toBeOnTheScreen();
      expect(listenForStatus).toHaveBeenCalledTimes(1);
      await advance(500);
      expect(subscribe).toHaveBeenCalledTimes(1);

      await act(() =>
        transport.pushRemoteStatus(host, {
          state: "connected",
          failure_kind: null,
        })
      );
      expect(
        await screen.findByText("Reconnecting", {}, { timeout: 250 })
      ).toBeOnTheScreen();
      expect(subscribe).toHaveBeenCalledTimes(1);
      await advance(1000);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
    } finally {
      await view.unmount();
    }
  } finally {
    transport.dispose();
    log.mockRestore();
    jest.useRealTimers();
  }
});
