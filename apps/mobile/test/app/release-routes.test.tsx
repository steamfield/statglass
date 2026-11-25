import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { cleanup } from "@testing-library/react-native";
import { renderRouter, screen } from "expo-router/testing-library";
import { Text } from "react-native";
import { useHosts } from "@/data/hosts-list";

const APP_DIR = "./src/app";
const runtime = globalThis as typeof globalThis & { __DEV__: boolean };
let wasDev: boolean;

beforeEach(() => {
  wasDev = __DEV__;
  installNative(null);
  jest.useFakeTimers();
});

afterEach(async () => {
  await cleanup();
  runtime.__DEV__ = wasDev;
  jest.useRealTimers();
});

function expectNativeHeader(title: string) {
  // The native header is drawn by UIKit. Jest can observe the title sent to it.
  expect(
    screen.root?.queryAll(
      (node) =>
        node.type === "RNSScreenStackHeaderConfig" &&
        node.props.title === title &&
        !node.props.hidden
    )
  ).toHaveLength(1);
}

test("a release debug deep link redirects to welcome", async () => {
  runtime.__DEV__ = false;
  const view = await renderRouter(APP_DIR, { initialUrl: "/debug" });
  expect(
    await screen.findByRole("button", { name: "Try demo hosts" })
  ).toBeOnTheScreen();
  expect(view.getPathname()).toBe("/");
});

test("the release stack leaves the debug header at the navigator default", async () => {
  runtime.__DEV__ = false;
  await renderRouter(
    {
      appDir: APP_DIR,
      // Keep the route mounted to observe the root stack's native header.
      overrides: { debug: () => <Text>Debug route</Text> },
    },
    { initialUrl: "/debug" }
  );
  expect(screen.getByText("Debug route")).toBeOnTheScreen();
  expectNativeHeader("debug");
});

test("a development debug deep link still opens the debug screen", async () => {
  runtime.__DEV__ = true;
  const native = new FakeNative();
  native.call.mockImplementation(async (method) => {
    if (method === "authorized_key_line") return ok("demo public key");
    return ok(method === "list_hosts" ? [] : null);
  });
  installNative(native);
  const view = await renderRouter(APP_DIR, { initialUrl: "/debug" });
  expect(
    await screen.findByRole("button", { name: "Connect" })
  ).toBeOnTheScreen();
  expect(view.getPathname()).toBe("/debug");
  expectNativeHeader("Debug");
});

function DemoRoster() {
  const { data } = useHosts();
  return data?.map(({ id, display_name }) => (
    <Text key={id}>{display_name}</Text>
  ));
}

test.each([
  [false, "MacBook Pro"],
  [true, "tailscale-down"],
] as const)(
  "with __DEV__ %s a demo deep link shows the expected roster",
  async (dev, shown) => {
    runtime.__DEV__ = dev;
    // Read the real demo roster without mounting the live charts. The full
    // hosts-list rendering is covered by the reviewer path test.
    await renderRouter(
      { appDir: APP_DIR, overrides: { "(hosts)/index": DemoRoster } },
      { initialUrl: "/demo?scenario=phone-errors" }
    );
    expect(await screen.findByText(shown)).toBeOnTheScreen();
    if (!dev) {
      expect(screen.queryByText("tailscale-down")).toBeNull();
    }
  }
);
