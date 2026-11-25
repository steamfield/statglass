/**
 * The first-launch screen through the real root layout, providers and router.
 */
import type { HostRecord, PairingPreview } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import {
  act,
  fireEvent,
  renderRouter,
  screen,
  testRouter,
  waitFor,
} from "expo-router/testing-library";

const APP_DIR = "./src/app";

test("offers one host pairing action and the demo", async () => {
  await renderRouter(APP_DIR, { initialUrl: "/" });

  expect(screen.getByRole("header", { name: "StatGlass" })).toBeOnTheScreen();
  expect(
    screen.getByText(/StatGlass shows your Macs' and servers' CPU/)
  ).toBeOnTheScreen();
  expect(screen.getAllByLabelText(/Example host/)).toHaveLength(1);
  const buttons = screen.getAllByRole("button");
  expect(buttons).toEqual([
    screen.getByRole("button", { name: "Add a host" }),
    screen.getByRole("button", { name: "Try demo hosts" }),
  ]);
});

test("Add a host opens the scan and paste choices for both sources", async () => {
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });

  await fireEvent.press(screen.getByRole("button", { name: "Add a host" }));

  expect(router.getPathname()).toBe("/pair");
  expect(
    await screen.findByRole("button", { name: "Scan QR" })
  ).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Paste code" })).toBeOnTheScreen();
  expect(screen.getByText(/StatGlass Settings.*Pair iPhone/)).toBeOnTheScreen();
});

test("waits for the restored roster and opens the native hosts", async () => {
  const native = new FakeNative();
  const roster = Promise.withResolvers<string>();
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts") return roster.promise;
    if (method === "pairing_state") return ok({ hosts: 1, key_changed: false });
    return ok(method === "list_remote_hosts" ? [] : null);
  });
  installNative(native);
  const view = await renderRouter(APP_DIR, { initialUrl: "/" });

  expect(screen.queryByRole("button", { name: "Add a host" })).toBeNull();
  const hosts = await createMockTransport().listHosts();
  await act(() => roster.resolve(ok(hosts)));
  expect(
    await screen.findByRole("button", { name: /^MacBook Pro,/ })
  ).toBeOnTheScreen();
  expect(view.getSegments()).toEqual(["(hosts)"]);
  expect(screen.queryByText("Demo")).toBeNull();
  expect(screen.queryByRole("button", { name: "Pair again" })).toBeNull();
});

test("a direct pairing link waits for startup and offers retry when it fails", async () => {
  const native = new FakeNative();
  const startup = Promise.withResolvers<string>();
  native.start.mockReturnValueOnce(startup.promise);
  native.call.mockImplementation(async (method) =>
    ok(method === "list_hosts" ? [] : null)
  );
  installNative(native);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  await renderRouter(APP_DIR, { initialUrl: "/pair" });
  expect(screen.queryByRole("button", { name: "Paste code" })).toBeNull();
  await act(() =>
    startup.resolve(
      JSON.stringify({
        status: "error",
        error: {
          kind: "internal",
          message: "Could not load the phone identity.",
        },
      })
    )
  );
  expect(
    await screen.findByText("Could not load the phone identity.")
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Paste code" })
  ).toBeOnTheScreen();
});

test("Done on a failed pairing returns to the screen that opened it", async () => {
  const view = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(
    await screen.findByRole("button", { name: "Add a host" })
  );
  await fireEvent.press(screen.getByRole("button", { name: "Paste code" }));
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code"),
    "SGPDEMO:invalid"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Preview host" }));
  await fireEvent.press(await screen.findByRole("button", { name: "Done" }));
  expect(view.getSegments()).toEqual([]);
  expect(screen.getByRole("button", { name: "Add a host" })).toBeOnTheScreen();
});

test("approval takes a fresh install to the paired host on the native transport", async () => {
  const native = new FakeNative();
  const hosts = await createMockTransport().listHosts();
  const first = hosts[0];
  if (!first) throw new Error("Expected a host fixture");
  const host: HostRecord = { ...first, display_name: "Paired host" };
  let paired = false;
  native.call.mockImplementation(async (method) => {
    switch (method) {
      case "list_hosts":
        return ok(paired ? [host] : []);
      case "preview_pairing":
        return ok({
          host_id: host.id,
          name: host.display_name,
          os: "Linux",
          user: "statglass",
          targets: [{ route: "lan", host: "build.local" }],
          code: "ABC123",
          expires_ms: Date.now() + 60_000,
          can_hand_over: false,
        } satisfies PairingPreview);
      case "pair":
        paired = true;
        // Rust announces the new roster before the pair call returns.
        native.emit("onCoreEvent", {
          event: JSON.stringify({ kind: "hosts_changed", hosts: [host] }),
        });
        return ok({ id: host.id, name: host.display_name });
      case "list_remote_hosts":
        return ok([]);
      default:
        return ok(null);
    }
  });
  installNative(native);
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });

  await fireEvent.press(
    await screen.findByRole("button", { name: "Add a host" })
  );
  await fireEvent.press(screen.getByRole("button", { name: "Paste code" }));
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code"),
    "SGP1:offer"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Preview host" }));
  await fireEvent.press(await screen.findByRole("button", { name: "Confirm" }));

  expect(
    await screen.findByRole("button", { name: /^Paired host,/ })
  ).toBeOnTheScreen();
  expect(router.getSegments()).toEqual(["(hosts)"]);
  expect(screen.queryByText("Demo")).toBeNull();
});

test("Try demo hosts replaces the entry route with the demo hosts list", async () => {
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(screen.getByRole("button", { name: "Try demo hosts" }));

  expect(await screen.findByText("Demo")).toBeOnTheScreen();
  expect(router.getSegments()).toEqual(["(hosts)"]);
  expect(
    await screen.findByRole("button", { name: /macOS, Live/ })
  ).toBeOnTheScreen();
});

test("View hosts opens the demo roster after a successful demo pairing", async () => {
  jest.useFakeTimers();
  const router = await renderRouter(APP_DIR, { initialUrl: "/pair" });
  try {
    await fireEvent.press(screen.getByRole("button", { name: "Paste code" }));
    await fireEvent.changeText(
      screen.getByLabelText("Pairing code"),
      "SGPDEMO:approve"
    );
    await fireEvent.press(screen.getByRole("button", { name: "Preview host" }));
    await fireEvent.press(screen.getByRole("button", { name: "Confirm" }));
    await act(() => jest.advanceTimersByTimeAsync(1000));
    expect(
      screen.getByRole("header", { name: "MacBook Pro is paired" })
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "View hosts" }));
    expect(router.getSegments()).toEqual(["(hosts)"]);
    expect(
      await screen.findByRole("button", { name: /^MacBook Pro,/ })
    ).toBeOnTheScreen();
  } finally {
    await router.unmount();
    jest.useRealTimers();
  }
});

test("returns to the demo hosts from the Settings navigation bar", async () => {
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(screen.getByRole("button", { name: "Try demo hosts" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: "Settings" })
  );
  expect(router.getPathname()).toBe("/settings");
  await fireEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(router.getSegments()).toEqual(["(hosts)"]);
  expect(await screen.findByText("Demo")).toBeOnTheScreen();
});

test("back from pairing returns to the demo hosts", async () => {
  const view = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(screen.getByRole("button", { name: "Try demo hosts" }));
  expect(await screen.findByText("Demo")).toBeOnTheScreen();

  await testRouter.push("/pair");
  expect(
    await screen.findByRole("button", { name: "Scan QR" })
  ).toBeOnTheScreen();
  await testRouter.back("/");

  expect(view.getSegments()).toEqual(["(hosts)"]);
  expect(await screen.findByText("Demo")).toBeOnTheScreen();
});

test("a restored iPhone shows Pair again above its saved hosts", async () => {
  const native = new FakeNative();
  const hosts = await createMockTransport().listHosts();
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts") return ok(hosts);
    if (method === "list_remote_hosts") return ok([]);
    if (method === "pairing_state") return ok({ hosts: 1, key_changed: true });
    return ok(null);
  });
  installNative(native);
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });

  expect(
    await screen.findByText(
      "This iPhone needs to pair again. Your hosts are still listed, and their history is on the hosts, but this phone has a new key after the restore."
    )
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", { name: /^MacBook Pro,/ })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Pair again" }));
  expect(router.getPathname()).toBe("/pair");
  expect(
    screen.getByRole("header", { name: "Get a pairing code" })
  ).toBeOnTheScreen();
});

test("logs a typed restore-state failure and keeps the saved roster available", async () => {
  const native = new FakeNative();
  const hosts = await createMockTransport().listHosts();
  const failure = { kind: "phone_key_unavailable" } as const;
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts") return ok(hosts);
    if (method === "list_remote_hosts") return ok([]);
    if (method === "pairing_state")
      return JSON.stringify({ status: "error", error: failure });
    return ok(null);
  });
  installNative(native);
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  await renderRouter(APP_DIR, { initialUrl: "/" });

  expect(
    await screen.findByRole("button", { name: /^MacBook Pro,/ })
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Pair again" })).toBeNull();
  await waitFor(() =>
    expect(warning).toHaveBeenCalledWith(
      "[pairing] Could not read restore state",
      failure
    )
  );
});
