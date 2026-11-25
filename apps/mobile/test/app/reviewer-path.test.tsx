import type { MobileCall } from "@core/generated/types";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import {
  fireEvent,
  renderRouter,
  screen,
  within,
} from "expo-router/testing-library";
// Load the screen modules before the test timeout starts. Expo Router still
// resolves and renders the actual routes from the app directory below.
import "@/app/_layout";
import "@/app/(hosts)/[host]/[module]";
import "@/app/(hosts)/[host]/index";
import "@/app/(hosts)/index";
import "@/app/index";

const runtime = globalThis as typeof globalThis & { __DEV__: boolean };
const hostMethods = new Set<MobileCall["method"]>([
  "set_hosts",
  "set_demand",
  "retry_remote_host",
  "subscribe_live",
  "authorized_key_line",
  "pairing_state",
  "preview_pairing",
  "pair",
  "decode_bundle",
  "add_handover_hosts",
]);
let wasDev: boolean;

beforeEach(() => {
  wasDev = __DEV__;
  runtime.__DEV__ = false;
  jest.useFakeTimers();
});

afterEach(() => {
  runtime.__DEV__ = wasDev;
  jest.useRealTimers();
});

test("a reviewer can open the CPU page without connecting to or pairing a host", async () => {
  const native = new FakeNative();
  native.call.mockImplementation(async (method) =>
    ok(method === "list_hosts" ? [] : null)
  );
  installNative(native);
  const view = await renderRouter("./src/app", { initialUrl: "/" });
  try {
    const demo = await screen.findByRole("button", { name: "Try demo hosts" });
    expect(screen.getByRole("header", { name: "StatGlass" })).toBeOnTheScreen();
    await fireEvent.press(demo);

    const host = await screen.findByRole("button", { name: /^MacBook Pro,/ });
    expect(screen.getByRole("button", { name: "Demo" })).toBeOnTheScreen();
    await fireEvent.press(host);

    const cpu = await screen.findByRole("button", { name: /^CPU,/ });
    // The card groups its touch controls under one VoiceOver target.
    await fireEvent.press(
      within(cpu).getByText("CPU", { includeHiddenElements: true })
    );

    expect(
      await screen.findByRole("tab", {
        name: "1h, History range",
        selected: true,
      })
    ).toBeOnTheScreen();
    expect(view.getPathname()).toMatch(/\/cpu$/);

    // The native core can start with an empty roster. All demo host activity
    // stays on the mock transport, including screen demand and live streams.
    expect(native.start).toHaveBeenCalled();
    for (const [config] of native.start.mock.calls) {
      expect(JSON.parse(config)).toMatchObject({ hosts: [] });
    }
    expect(native.preparePhoneKey).not.toHaveBeenCalled();
    expect(
      native.call.mock.calls.filter(([method]) => hostMethods.has(method))
    ).toEqual([]);
  } finally {
    await view.unmount();
  }
});
