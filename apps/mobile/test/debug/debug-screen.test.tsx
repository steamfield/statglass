import type {
  CommandError,
  LiveMsg,
  MobileConfig,
  MobileHost,
  MobileRemoteHost,
} from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { HOST, REMOTE } from "@test/transport/native-fixtures";
import { ExpoRoot, router, Stack } from "expo-router";
import {
  act,
  fireEvent,
  getMockContext,
  screen,
} from "expo-router/testing-library";
import DebugScreen from "@/app/debug";
import DataSettings from "@/app/settings/data";
import { CoreProvider, NativeCoreBridge } from "@/transport";

const KEY_LINE = "ecdsa-sha2-nistp256 fake-public-key statglass-iphone";
const SHA256 = `SHA256:${"A".repeat(43)}`;
const CONNECTED: MobileRemoteHost = {
  ...REMOTE,
  waiting_for_network: false,
  next_attempt_ms: null,
  identity_changed: null,
  connection: {
    state: "connected",
    route: "tailscale",
    sync: "current",
    failure: null,
    incompatible_side: null,
    message: null,
    route_failures: [],
  },
};
const CONNECTING: MobileRemoteHost = {
  ...CONNECTED,
  dialing: true,
  last_seen_ms: null,
  connection: { ...CONNECTED.connection, state: "connecting" },
};

const routes = getMockContext({
  _layout: () => <Stack />,
  debug: DebugScreen,
  data: DataSettings,
});

function renderDebug() {
  mockAppState();
  return renderWithProviders(
    <CoreProvider>
      <ExpoRoot context={routes} location="/debug" />
    </CoreProvider>
  );
}

function debugModule() {
  const native = new FakeNative();
  const call = native.call.getMockImplementation();
  let remotes = [CONNECTED];
  native.call.mockImplementation(async (method, args) => {
    if (method === "authorized_key_line") return ok(KEY_LINE);
    if (method === "list_hosts") return ok([]);
    if (method === "list_remote_hosts") return ok(remotes);
    return call?.(method, args) ?? ok(null);
  });
  installNative(native);
  return {
    native,
    setRemotes(next: MobileRemoteHost[]) {
      remotes = next;
      native.emit("onCoreEvent", {
        event: JSON.stringify({ kind: "remote_hosts_changed" }),
      });
    },
  };
}

function live(native: FakeNative, stream: number, msg: LiveMsg) {
  native.emit("onLive", { stream, message: JSON.stringify(msg) });
}

function pushCpu(native: FakeNative, stream: number, cpu: number) {
  live(native, stream, {
    kind: "layout",
    layout_no: 5,
    series: [{ metric: "cpu.total", labels: [] }],
    kinds: ["gauge"],
  });
  live(native, stream, {
    kind: "frame",
    layout_no: 5,
    ts_ms: 1000,
    timeline: 0,
    values: [cpu],
    held: [cpu],
  });
}

async function fillHost() {
  await fireEvent.changeText(screen.getByLabelText("Address"), "studio.local");
  await fireEvent.changeText(screen.getByLabelText("SSH user"), "demo");
  await fireEvent.changeText(screen.getByLabelText("StatGlass host ID"), HOST);
  await fireEvent.changeText(
    screen.getByLabelText("SSH host key pin"),
    `ssh-ed25519 ${SHA256}`
  );
}

test("requires a development build when the native module is absent", async () => {
  installNative(null);
  await renderDebug();
  expect(
    await screen.findByText("The debug screen needs a development build.")
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});

test("starts with the current cellular live setting and updates the open debug core", async () => {
  const { native } = debugModule();
  await renderWithProviders(
    <CoreProvider>
      <NativeCoreBridge />
      <ExpoRoot context={routes} location="/debug" />
    </CoreProvider>,
    { settings: { liveOnCellular: false } }
  );
  expect(await screen.findByText(KEY_LINE)).toBeOnTheScreen();
  expect(native.start).toHaveBeenCalledWith(
    JSON.stringify({
      hosts: [],
      data: { live_on_cellular: false },
    } satisfies MobileConfig)
  );

  await act(() => router.push("/data"));
  const cellularLive = screen.getByRole("switch", {
    name: "Live updates on cellular",
  });
  expect(cellularLive).not.toBeChecked();
  await fireEvent(cellularLive, "valueChange", true);
  expect(native.call).toHaveBeenCalledWith(
    "set_data_policy",
    '{"live_on_cellular":true}'
  );
  expect(native.start).toHaveBeenCalledTimes(1);
});

test("starts once, shows the key, then connects with the submitted Mac and displays live CPU", async () => {
  const { native, setRemotes } = debugModule();
  const view = await renderDebug();
  expect(await screen.findByText(KEY_LINE)).toBeOnTheScreen();
  expect(native.start.mock.calls).toEqual([
    [
      JSON.stringify({
        hosts: [],
        data: { live_on_cellular: true },
      } satisfies MobileConfig),
    ],
  ]);
  await fillHost();
  await fireEvent.changeText(
    screen.getByLabelText("SSH port (optional)"),
    "2222"
  );
  await fireEvent.changeText(
    screen.getByLabelText("Helper path (optional)"),
    "/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper"
  );
  await fireEvent.press(screen.getByRole("radio", { name: "Tailscale" }));
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Live")).toBeOnTheScreen();
  expect(native.call).toHaveBeenCalledWith(
    "set_hosts",
    JSON.stringify({
      hosts: [
        {
          id: HOST,
          name: "studio.local",
          user: "demo",
          port: 2222,
          targets: [{ route: "tailscale", host: "studio.local" }],
          host_keys: [{ algorithm: "ssh-ed25519", sha256: SHA256 }],
          command: {
            kind: "mac_helper",
            path: "/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper",
          },
        } satisfies MobileHost,
      ],
    })
  );

  await act(() => pushCpu(native, 1, 39));
  expect(screen.getByText("39%")).toHaveStyle({
    fontVariant: ["tabular-nums"],
  });

  await act(() => setRemotes([REMOTE]));
  expect(await screen.findByText("Timed out")).toBeOnTheScreen();
  expect(screen.queryByText("39%")).toBeNull();
  await act(() => pushCpu(native, 1, 43));
  await act(() => setRemotes([CONNECTED]));
  expect(await screen.findByText("Live")).toBeOnTheScreen();
  expect(screen.queryByText("39%")).toBeNull();
  expect(screen.queryByText("43%")).toBeNull();
  await act(() => pushCpu(native, 1, 45));
  expect(screen.getByText("45%")).toBeOnTheScreen();
  await act(() => setRemotes([CONNECTING]));
  expect(await screen.findByText("Connecting")).toBeOnTheScreen();
  await act(() => setRemotes([CONNECTED]));
  expect(await screen.findByText("Live")).toBeOnTheScreen();
  expect(screen.queryByText("45%")).toBeNull();

  await view.unmount();
  expect(native.listenerCount("onLive")).toBe(0);
  expect(native.listenerCount("onCoreEvent")).toBe(0);
  expect(native.call).toHaveBeenCalledWith("unsubscribe_live", '{"stream":1}');
  await renderDebug();
  expect(await screen.findByText(KEY_LINE)).toBeOnTheScreen();
  expect(native.start).toHaveBeenCalledTimes(1);
});

test("a failed status refresh hides the cached Live reading", async () => {
  const { native, setRemotes } = debugModule();
  await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("Live");
  await act(() => pushCpu(native, 1, 39));
  expect(screen.getByText("39%")).toBeOnTheScreen();

  const call = native.call.getMockImplementation();
  native.call.mockImplementation(async (method, args) =>
    method === "list_remote_hosts"
      ? JSON.stringify({
          status: "error",
          error: {
            kind: "invalid_argument",
            message: "Status failed",
          } satisfies CommandError,
        })
      : (call?.(method, args) ?? ok(null))
  );
  await act(() => setRemotes([CONNECTED]));
  expect(
    await screen.findByRole("alert", { name: /Status failed/ })
  ).toBeOnTheScreen();
  expect(screen.queryByText("Live")).toBeNull();
  expect(screen.queryByText("39%")).toBeNull();
});

test("a silent live stream hides the last CPU reading and looks for a new frame", async () => {
  jest.useFakeTimers();
  try {
    const { native } = debugModule();
    await renderDebug();
    await screen.findByText(KEY_LINE);
    await fillHost();
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live");
    await act(() => {
      live(native, 1, {
        kind: "status",
        interval_ms: 1000,
        frame_period_ms: 1000,
        paused: false,
        display_idle: false,
        on_battery: false,
        power_source: "adapter",
        performance: "off",
        primary_iface: null,
      });
      pushCpu(native, 1, 39);
    });
    expect(screen.getByText("39%")).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTimeAsync(3000));
    expect(screen.getByText("Reconnecting")).toBeOnTheScreen();
    expect(screen.queryByText("39%")).toBeNull();
    await act(() => pushCpu(native, 1, 40));
    expect(screen.getByText("40%")).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

test("keeps the first CPU frame that comes before the connected status", async () => {
  const { native, setRemotes } = debugModule();
  setRemotes([CONNECTING]);
  await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByText("Connecting")).toBeOnTheScreen();
  await act(() => pushCpu(native, 1, 41));
  await act(() => setRemotes([CONNECTED]));
  expect(await screen.findByText("Live")).toBeOnTheScreen();
  expect(screen.getByText("41%")).toBeOnTheScreen();
});

test("stops the live subscription before clearing the debug host on unmount", async () => {
  const { native } = debugModule();
  const view = await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("Live");
  await view.unmount();
  expect(native.call.mock.calls.slice(-2)).toEqual([
    ["unsubscribe_live", '{"stream":1}'],
    ["set_hosts", '{"hosts":[]}'],
  ]);
  await renderDebug();
  expect(await screen.findByText("Disconnected")).toBeOnTheScreen();
});

test("clears the debug host after an in-flight Connect settles, and reports a cleanup failure", async () => {
  const { native } = debugModule();
  const view = await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  const reply = Promise.withResolvers<string>();
  native.call.mockReturnValueOnce(reply.promise);
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(native.call).toHaveBeenLastCalledWith(
    "set_hosts",
    expect.stringContaining(HOST)
  );
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  await view.unmount();
  expect(native.call).not.toHaveBeenCalledWith("set_hosts", '{"hosts":[]}');
  const error: CommandError = {
    kind: "internal",
    message: "Could not clear hosts",
  };
  native.call.mockResolvedValueOnce(JSON.stringify({ status: "error", error }));
  await act(() => reply.resolve(ok(null)));
  expect(native.call).toHaveBeenLastCalledWith("set_hosts", '{"hosts":[]}');
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("clear debug hosts"),
    error
  );
});

test("does not replace the app’s selected native hosts", async () => {
  const { native } = debugModule();
  const call = native.call.getMockImplementation();
  const hosts = await createMockTransport().listHosts();
  native.call.mockImplementation(async (method, args) =>
    method === "list_hosts" ? ok(hosts) : (call?.(method, args) ?? ok(null))
  );
  await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(
    await screen.findByText(
      "Close the current hosts session before connecting from Debug."
    )
  ).toBeOnTheScreen();
  expect(native.call).not.toHaveBeenCalledWith("set_hosts", expect.any(String));
});

test("opens a fresh stream when the replacement host becomes available", async () => {
  const { native } = debugModule();
  const call = native.call.getMockImplementation();
  let replacing = false;
  native.call.mockImplementation(async (method, args) => {
    if (replacing && method === "subscribe_live") {
      const error: CommandError = { kind: "unknown_host", host: HOST };
      return JSON.stringify({ status: "error", error });
    }
    return call?.(method, args) ?? ok(null);
  });
  await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  const connect = () =>
    fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  await connect();
  expect(await screen.findByText("Live")).toBeOnTheScreen();
  replacing = true;
  await fireEvent.changeText(
    screen.getByLabelText("Address"),
    "replacement.local"
  );
  await connect();
  expect(
    native.call.mock.calls.filter(([method]) => method === "subscribe_live")
  ).toHaveLength(2);
  replacing = false;
  const [source] = await createMockTransport().listHosts();
  await act(() =>
    native.emit("onCoreEvent", {
      event: JSON.stringify({
        kind: "hosts_changed",
        hosts: [{ ...source, id: HOST, is_local: false }],
      }),
    })
  );
  expect(
    native.call.mock.calls.filter(([method]) => method === "subscribe_live")
  ).toHaveLength(3);
  await act(() => pushCpu(native, 3, 53));
  expect(screen.getByText("53%")).toBeOnTheScreen();
});

test("Connect retries the same host after an SSH authentication failure", async () => {
  const { native, setRemotes } = debugModule();
  await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  const connect = () =>
    fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  await connect();
  expect(await screen.findByText("Live")).toBeOnTheScreen();
  await act(() =>
    setRemotes([
      {
        ...REMOTE,
        connection: {
          ...REMOTE.connection,
          failure: "authentication",
          message: "SSH authentication failed",
        },
      },
    ])
  );
  expect(
    await screen.findByText("SSH authentication failed")
  ).toBeOnTheScreen();
  await connect();
  expect(native.call).toHaveBeenCalledWith(
    "retry_remote_host",
    JSON.stringify({ host: HOST })
  );
});

test("validates a port before changing the host and shows a failed connect", async () => {
  const { native } = debugModule();
  await renderDebug();
  await screen.findByText(KEY_LINE);
  await fillHost();
  const address = screen.getByLabelText("Address");
  await fireEvent.changeText(address, "demo@studio.local");
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(
    screen.getByRole("alert", {
      name: "Enter a hostname or IP address. Put the username in SSH user.",
    })
  ).toBeOnTheScreen();
  expect(native.call).not.toHaveBeenCalledWith("set_hosts", expect.any(String));
  await fireEvent.changeText(address, "studio.local");
  const port = screen.getByLabelText("SSH port (optional)");
  await fireEvent.changeText(port, "65536");
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(
    screen.getByRole("alert", { name: "Enter an SSH port from 1 to 65535." })
  ).toBeOnTheScreen();
  expect(native.call).not.toHaveBeenCalledWith("set_hosts", expect.any(String));

  const error: CommandError = {
    kind: "internal",
    message: "The Mac could not be configured.",
  };
  native.call.mockResolvedValueOnce(JSON.stringify({ status: "error", error }));
  await fireEvent.changeText(port, "");
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(
    await screen.findByRole("alert", { name: error.message })
  ).toBeOnTheScreen();
  expect(native.call).not.toHaveBeenCalledWith(
    "subscribe_live",
    expect.any(String)
  );
  expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
});
