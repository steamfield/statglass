import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative } from "@test/transport/fake-native";
import { ExpoRoot, router, Stack, usePathname } from "expo-router";
import {
  act,
  fireEvent,
  getMockContext,
  renderRouter,
  screen,
} from "expo-router/testing-library";
import { ActionSheetIOS, Pressable } from "react-native";
import RootLayout from "@/app/_layout";
import HostsLayout from "@/app/(hosts)/_layout";
import HostsRoute from "@/app/(hosts)/index";
import Debug from "@/app/debug";
import Demo from "@/app/demo";
import Pair from "@/app/pair";
import PairHosts from "@/app/pair-hosts";
import About from "@/app/settings/about";
import Appearance from "@/app/settings/appearance";
import Data from "@/app/settings/data";
import Device from "@/app/settings/device";
import Settings from "@/app/settings/index";
import UpdateFromMac from "@/app/update-from-mac";
import { useIsDemo, useOptionalPhoneTransport } from "@/data/transport-context";
import { createNativeTransport } from "@/transport";
import { Text } from "@/ui/text";

const APP_DIR = "./src/app";
const SETTINGS = { name: "Settings" };
const BACK = { name: "Back" };

function OpenSettings() {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push("/settings")}
    >
      <Text variant="body">Open Settings</Text>
    </Pressable>
  );
}

const ROOT_ROUTES = {
  _layout: RootLayout,
  index: OpenSettings,
  pair: Pair,
  demo: Demo,
  "(hosts)/_layout": HostsLayout,
  "(hosts)/index": HostsRoute,
  "(hosts)/[host]/index": () => null,
  "(hosts)/[host]/[module]": () => null,
  "settings/index": Settings,
  "settings/device": Device,
  "settings/data": Data,
  "settings/about": About,
  "settings/appearance": Appearance,
  // The roster and detail behavior are covered through their routes in test/settings.
  "settings/hosts": () => null,
  "settings/host/[host]": () => null,
  "update-from-mac": UpdateFromMac,
  "pair-hosts": PairHosts,
  debug: Debug,
};

function header(title: string, largeTitle: boolean) {
  // react-native-screens is the platform boundary. Jest cannot draw UIKit blur.
  const config = screen.root
    ?.queryAll(
      (node) =>
        node.type === "RNSScreenStackHeaderConfig" &&
        node.props.title === title &&
        !node.props.hidden
    )
    .at(-1);
  expect(config?.props).toMatchObject({
    title,
    largeTitle,
    blurEffect: "systemChromeMaterial",
    hideBackButton: true,
    ...(largeTitle && { largeTitleBackgroundColor: "transparent" }),
  });
}

test("the hosts stack gives host and module titles their own header size", async () => {
  function Host() {
    // Lane c1 supplies the title through this Stack.Screen contract.
    return <Stack.Screen options={{ title: "MacBook Pro" }} />;
  }
  function Module() {
    // Lane e sets the title while the hosts layout sets the bar's size.
    return <Stack.Screen options={{ title: "CPU" }} />;
  }
  const routes = getMockContext({
    _layout: () => <Stack screenOptions={{ headerShown: false }} />,
    "(hosts)/_layout": HostsLayout,
    "(hosts)/index": () => <Text variant="body">Host list content</Text>,
    "(hosts)/[host]/index": Host,
    "(hosts)/[host]/[module]": Module,
  });
  await renderWithProviders(<ExpoRoot context={routes} location="/(hosts)" />, {
    transport: createNativeTransport(new FakeNative()),
  });
  header("Hosts", true);

  await act(() => router.push("/(hosts)/remote-studio"));
  expect(screen.getByRole("button", BACK)).toBeOnTheScreen();
  header("MacBook Pro", true);

  await act(() => router.push("/(hosts)/remote-studio/cpu"));
  expect(screen.getByRole("button", BACK)).toBeOnTheScreen();
  header("CPU", false);
  await fireEvent.press(screen.getByRole("button", BACK));
  header("MacBook Pro", true);
});

test("settings opens on the root stack and its pages use the same back control", async () => {
  installNative(null);
  await renderRouter(ROOT_ROUTES);
  await fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
  header("Settings", true);

  for (const title of ["This iPhone", "Data", "Appearance", "About"]) {
    await fireEvent.press(screen.getByRole("button", { name: title }));
    header(title, true);
    await fireEvent.press(screen.getByRole("button", BACK));
    expect(screen.getByRole("button", { name: title })).toBeOnTheScreen();
  }

  await fireEvent.press(screen.getByRole("button", BACK));
  expect(
    screen.getByRole("button", { name: "Open Settings" })
  ).toBeOnTheScreen();
});

test.each([
  ["/pair", "Add a host"],
  ["/update-from-mac", "Update from Mac"],
  ["/pair-hosts", "Also on this Mac"],
  ["/debug", "Debug"],
  ["/settings/hosts", "Hosts"],
  ["/settings/host/remote-studio", "Host details"],
] as const)(
  "%s inherits the material and back chevron",
  async (path, title) => {
    installNative(null);
    const view = await renderRouter(ROOT_ROUTES);
    await act(() => router.push(path));
    header(title, path === "/settings/hosts");
    await fireEvent.press(screen.getByRole("button", BACK));
    expect(view.getPathname()).toBe("/");
    expect(
      screen.getByRole("button", { name: "Open Settings" })
    ).toBeOnTheScreen();
  }
);

test("the Demo badge exits to welcome and clears the selected demo transport", async () => {
  installNative(null);
  function Welcome() {
    const demo = useIsDemo();
    const transport = useOptionalPhoneTransport();
    const path = usePathname();
    return (
      <Text variant="title">
        {path === "/" && !demo && !transport
          ? "Welcome without a demo"
          : "Demo still selected"}
      </Text>
    );
  }
  const menu = jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => undefined);
  await renderRouter(
    { ...ROOT_ROUTES, index: Welcome },
    { initialUrl: "/demo?scenario=host-unreachable" }
  );
  await fireEvent.press(await screen.findByRole("button", SETTINGS));
  header("Settings", true);
  await fireEvent.press(screen.getByRole("button", BACK));
  await fireEvent.press(await screen.findByRole("button", { name: "Demo" }));
  const action = menu.mock.lastCall;
  expect(action?.[0].options).toEqual(["Exit demo", "Cancel"]);
  if (!action) throw new Error("Expected the demo action sheet");
  await act(() => action[1](0));
  expect(
    await screen.findByRole("header", { name: "Welcome without a demo" })
  ).toBeOnTheScreen();
});

test("Settings has no nested stack and the dev primitives route is absent", () => {
  expect(existsSync(`${APP_DIR}/settings/_layout.tsx`)).toBe(false);
  expect(existsSync(`${APP_DIR}/dev/primitives.tsx`)).toBe(false);
});

test("app routes share the native header without route-local tints or back chevrons", () => {
  const sources = "./src";
  const files = readdirSync(sources, {
    recursive: true,
    encoding: "utf8",
  }).filter((path) => /\.tsx?$/.test(path) && !path.startsWith("ui/"));
  const overrides = files.filter((path) => {
    const source = readFileSync(`${sources}/${path}`, "utf8");
    return (
      /\bheader(?:TintColor|BackTitle|Left)\s*:|<BackButton\b|chevron\.left/.test(
        source
      ) ||
      (path.startsWith("app/") && /<Svg\b/.test(source))
    );
  });
  expect(overrides).toEqual([]);
});
