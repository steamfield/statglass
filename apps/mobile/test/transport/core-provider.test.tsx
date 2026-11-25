import type { CommandError } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import type { NativeError } from "@core/native-errors";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { act, screen, waitFor, within } from "@testing-library/react-native";
import {
  fireEvent,
  renderRouter,
  testRouter,
} from "expo-router/testing-library";
import { Activity, StrictMode } from "react";
import { AccessibilityInfo, Pressable, Text } from "react-native";
import FirstLaunch from "@/app/index";
import {
  useOptionalPhoneTransport,
  usePhoneTransport,
  useSetPhoneTransport,
} from "@/data/transport-context";
import { CoreProvider, useNativeCore } from "@/transport";

function CoreConsumer() {
  const { core } = useNativeCore();
  const transport = useOptionalPhoneTransport();
  return (
    <Text>
      {core === null
        ? "Waiting"
        : transport === core
          ? "Native hosts"
          : "No native hosts"}
    </Text>
  );
}

test("starts once, selects the same native transport, and disposes it on unmount", async () => {
  const native = new FakeNative();
  const hosts = await createMockTransport().listHosts();
  const start = Promise.withResolvers<string>();
  native.start.mockReturnValueOnce(start.promise);
  native.call.mockImplementation(async () => ok(hosts));
  installNative(native);
  const view = await renderWithProviders(
    <StrictMode>
      <CoreProvider>
        <CoreConsumer />
      </CoreProvider>
    </StrictMode>,
    { settings: { liveOnCellular: false } }
  );
  expect(screen.getByText("Waiting")).toBeOnTheScreen();
  expect(native.start.mock.calls.map(([config]) => JSON.parse(config))).toEqual(
    [{ hosts: [], data: { live_on_cellular: false } }]
  );
  await act(() => start.resolve(ok(null)));
  expect(screen.getByText("Native hosts")).toBeOnTheScreen();
  expect(native.listenerCount("onCoreEvent")).toBe(1);
  await view.unmount();
  expect(native.listenerCount("onCoreEvent")).toBe(0);

  await renderWithProviders(
    <CoreProvider>
      <CoreConsumer />
    </CoreProvider>
  );
  expect(await screen.findByText("Native hosts")).toBeOnTheScreen();
  expect(native.start).toHaveBeenCalledTimes(1);
});

test("starts a core with an empty roster without selecting a transport", async () => {
  const native = new FakeNative();
  native.call.mockImplementation(async () => ok([]));
  installNative(native);
  await renderWithProviders(
    <CoreProvider>
      <CoreConsumer />
    </CoreProvider>
  );
  expect(await screen.findByText("No native hosts")).toBeOnTheScreen();
});

test("a roster event selects native transport after an empty start", async () => {
  const native = new FakeNative();
  native.call.mockImplementation(async () => ok([]));
  installNative(native);
  const hosts = await createMockTransport().listHosts();
  await renderWithProviders(
    <CoreProvider>
      <CoreConsumer />
    </CoreProvider>
  );
  expect(await screen.findByText("No native hosts")).toBeOnTheScreen();
  await act(() =>
    native.emit("onCoreEvent", {
      event: JSON.stringify({ kind: "hosts_changed", hosts }),
    })
  );
  expect(await screen.findByText("Native hosts")).toBeOnTheScreen();
});

test("a roster event during startup takes precedence over the initial read", async () => {
  const native = new FakeNative();
  const roster = Promise.withResolvers<string>();
  native.call.mockReturnValueOnce(roster.promise);
  installNative(native);
  const hosts = await createMockTransport().listHosts();
  await renderWithProviders(
    <CoreProvider>
      <CoreConsumer />
    </CoreProvider>
  );
  await waitFor(() =>
    expect(native.call).toHaveBeenCalledWith("list_hosts", "null")
  );
  await act(() =>
    native.emit("onCoreEvent", {
      event: JSON.stringify({ kind: "hosts_changed", hosts }),
    })
  );
  await act(() => roster.resolve(ok([])));
  expect(await screen.findByText("Native hosts")).toBeOnTheScreen();
});

test("restarting the core effect clears the disposed selection and selects the replacement", async () => {
  const native = new FakeNative();
  const hosts = await createMockTransport().listHosts();
  const demo = createMockTransport();
  const next = Promise.withResolvers<string>();
  native.call
    .mockResolvedValueOnce(ok(hosts))
    .mockReturnValueOnce(next.promise);
  installNative(native);
  function Choice() {
    const choice = useOptionalPhoneTransport();
    const select = useSetPhoneTransport();
    return (
      <>
        <Text>
          {choice === demo
            ? "Demo selected"
            : choice
              ? "Transport selected"
              : "Transport cleared"}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => select(demo, true)}
        >
          <Text>Choose demo</Text>
        </Pressable>
      </>
    );
  }
  function Tree({ visible }: { visible: boolean }) {
    return (
      <>
        <Choice />
        <Activity mode={visible ? "visible" : "hidden"}>
          <CoreProvider>
            <CoreConsumer />
          </CoreProvider>
        </Activity>
      </>
    );
  }
  const view = await renderWithProviders(<Tree visible />);
  expect(await screen.findByText("Native hosts")).toBeOnTheScreen();
  await view.rerender(<Tree visible={false} />);
  expect(screen.getByText("Transport cleared")).toBeOnTheScreen();
  expect(native.listenerCount("onCoreEvent")).toBe(0);
  expect(
    screen.getByText("Waiting", { includeHiddenElements: true })
  ).toBeOnTheScreen();
  await view.rerender(<Tree visible />);
  expect(screen.getByText("Transport cleared")).toBeOnTheScreen();
  expect(screen.getByText("Waiting")).toBeOnTheScreen();
  await act(() => next.resolve(ok(hosts)));
  expect(await screen.findByText("Native hosts")).toBeOnTheScreen();
  expect(native.start).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("button", { name: "Choose demo" }));
  await view.rerender(<Tree visible={false} />);
  expect(screen.getByText("Demo selected")).toBeOnTheScreen();
});

test("a cold host link waits for the startup roster", async () => {
  const native = new FakeNative();
  const records = await createMockTransport().listHosts();
  const roster = Promise.withResolvers<string>();
  native.call.mockImplementation(async (method) =>
    method === "list_hosts" ? roster.promise : ok(null)
  );
  installNative(native);
  function HostRoute() {
    const transport = usePhoneTransport();
    const { core } = useNativeCore();
    return (
      <Text>
        {transport === core ? "Opened native host" : "Other transport"}
      </Text>
    );
  }
  const view = await renderRouter(
    { appDir: "./src/app", overrides: { "(hosts)/[host]/index": HostRoute } },
    { initialUrl: "/(hosts)/paired-host" }
  );
  expect(view.getSegments()).toEqual(["(hosts)", "[host]"]);
  expect(screen.queryByText("Opened native host")).toBeNull();
  await act(() => roster.resolve(ok(records)));
  expect(await screen.findByText("Opened native host")).toBeOnTheScreen();
});

test("shows the command startup error and starts successfully on Retry", async () => {
  const native = new FakeNative();
  const error: CommandError = {
    kind: "internal",
    message: "Could not load the phone identity.",
  };
  native.start.mockResolvedValueOnce(
    JSON.stringify({ status: "error", error })
  );
  const response = Promise.withResolvers<string>();
  native.start.mockReturnValueOnce(response.promise);
  native.call.mockImplementation(async () => ok([]));
  installNative(native);
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  function Welcome() {
    return (
      <>
        <FirstLaunch />
        <CoreConsumer />
      </>
    );
  }
  const view = await renderRouter(
    { appDir: "./src/app", overrides: { index: Welcome } },
    { initialUrl: "/" }
  );
  expect(
    await screen.findByRole("header", { name: "StatGlass couldn’t start" })
  ).toBeOnTheScreen();
  const [viewport] =
    view.root?.queryAll((element) => element.type === "RCTScrollView") ?? [];
  if (!viewport) throw new Error("The welcome content cannot scroll");
  const welcome = within(viewport);
  expect(welcome.getByText(error.message)).toBeOnTheScreen();
  expect(
    welcome.getByRole("button", { name: "Try demo hosts" })
  ).toBeOnTheScreen();
  expect(log).toHaveBeenCalledWith("[native core] startup failed", {
    attempt: 1,
    error,
  });
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByText("Waiting")).toBeOnTheScreen();
  await act(() => response.resolve(ok(null)));
  expect(await screen.findByText("No native hosts")).toBeOnTheScreen();
  expect(native.start).toHaveBeenCalledTimes(2);
  expect(announce.mock.calls).toEqual([["StatGlass couldn’t start"]]);
});

test("a late native start failure leaves the active demo available", async () => {
  const native = new FakeNative();
  const pending = Promise.withResolvers<string>();
  native.start.mockReturnValueOnce(pending.promise);
  installNative(native);
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockClear();
  await renderRouter("./src/app", {
    initialUrl: "/demo?scenario=host-unreachable",
  });
  const demoHost = { name: /^unreachable,/ };
  expect(await screen.findByRole("button", demoHost)).toBeOnTheScreen();
  const error: CommandError = {
    kind: "internal",
    message: "Could not load the phone identity.",
  };
  await act(() => pending.resolve(JSON.stringify({ status: "error", error })));
  expect(log).toHaveBeenCalledWith("[native core] startup failed", {
    attempt: 1,
    error,
  });
  expect(screen.getByRole("button", demoHost)).toBeOnTheScreen();
  expect(announce).not.toHaveBeenCalled();
});

test("announces a different startup failure after retrying", async () => {
  const native = new FakeNative();
  const firstFailure = "Could not read the phone identity.";
  const secondFailure = "Could not open the phone data directory.";
  for (const message of [firstFailure, secondFailure]) {
    native.start.mockResolvedValueOnce(
      JSON.stringify({ status: "error", error: { kind: "internal", message } })
    );
  }
  installNative(native);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  const announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockClear();
  await renderRouter("./src/app");
  expect(await screen.findByText(firstFailure)).toBeOnTheScreen();
  expect(announce.mock.calls).toEqual([["StatGlass couldn’t start"]]);
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(secondFailure)).toBeOnTheScreen();
  expect(announce.mock.calls).toEqual([
    ["StatGlass couldn’t start"],
    ["StatGlass couldn’t start"],
  ]);
});

test("keeps a Swift rejection typed and shows its message", async () => {
  const native = new FakeNative();
  native.start.mockRejectedValueOnce({
    code: "ERR_STATGLASS_KEYCHAIN",
    message: "The phone is locked. (OSStatus -25308)",
  });
  installNative(native);
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  await renderRouter("./src/app", { initialUrl: "/debug" });
  expect(
    await screen.findByRole("button", { name: "Retry" })
  ).toBeOnTheScreen();
  const error: NativeError = {
    source: "native",
    kind: "keychain",
    osStatus: -25308,
    message: "The phone is locked.",
  };
  await waitFor(() =>
    expect(log).toHaveBeenCalledWith("[native core] startup failed", {
      attempt: 1,
      error,
    })
  );
  expect(
    screen.queryByText("Unlock this iPhone to connect") ??
      screen.getByText("The phone is locked.")
  ).toBeOnTheScreen();
  expect(
    screen.queryByText("The debug screen needs a development build.")
  ).toBeNull();
});

test("Debug shows the startup failure and can retry while the demo is active", async () => {
  const native = new FakeNative();
  native.start.mockRejectedValueOnce({
    code: "ERR_STATGLASS_KEYCHAIN",
    message: "The phone is locked. (OSStatus -25308)",
  });
  native.call.mockImplementation(async (method) =>
    ok(method === "list_hosts" ? [] : "Recovered SSH key")
  );
  installNative(native);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  await renderRouter("./src/app", {
    initialUrl: "/demo?scenario=host-unreachable",
  });
  expect(
    await screen.findByRole("button", { name: /^unreachable,/ })
  ).toBeOnTheScreen();
  await testRouter.push("/debug");
  expect(
    screen.queryByText("Unlock this iPhone to connect") ??
      screen.getByText("The phone is locked.")
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Recovered SSH key")).toBeOnTheScreen();
  await testRouter.back("/");
  expect(
    await screen.findByRole("button", { name: /^unreachable,/ })
  ).toBeOnTheScreen();
});
