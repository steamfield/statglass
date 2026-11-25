import type { CommandError } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import type { NativeError } from "@core/native-errors";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { act, screen, waitFor } from "@testing-library/react-native";
import { fireEvent, renderRouter } from "expo-router/testing-library";
import { StrictMode, useEffect } from "react";
import { Text } from "react-native";
import {
  useOptionalPhoneTransport,
  usePhoneTransport,
} from "@/data/transport-context";
import { CoreProvider, useNativeCore } from "@/transport";

function CoreConsumer() {
  const { core } = useNativeCore();
  const transport = useOptionalPhoneTransport();
  useEffect(() => {
    // Leave a subscription pending so unmount exercises the owner's disposal.
    core?.onHostsChanged(() => undefined);
  }, [core]);
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
  await renderRouter(
    { appDir: "./src/app", overrides: { index: CoreConsumer } },
    { initialUrl: "/" }
  );
  expect(
    await screen.findByRole("alert", { name: "StatGlass couldn’t start" })
  ).toBeOnTheScreen();
  expect(screen.getByText(error.message)).toBeOnTheScreen();
  expect(log).toHaveBeenCalledWith("[native core] startup failed", {
    attempt: 1,
    error,
  });
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByText("Waiting")).toBeOnTheScreen();
  await act(() => response.resolve(ok(null)));
  expect(await screen.findByText("No native hosts")).toBeOnTheScreen();
  expect(native.start).toHaveBeenCalledTimes(2);
});

test("a late native start failure leaves the active demo available", async () => {
  const native = new FakeNative();
  const pending = Promise.withResolvers<string>();
  native.start.mockReturnValueOnce(pending.promise);
  installNative(native);
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
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
