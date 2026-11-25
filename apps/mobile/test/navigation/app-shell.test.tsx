import { readdirSync, readFileSync } from "node:fs";
import { expect, jest, test } from "@jest/globals";
import { installNative } from "@test/transport/fake-native";
import { useTheme } from "expo-router";
import {
  act,
  fireEvent,
  renderRouter,
  screen,
} from "expo-router/testing-library";
import { useSyncExternalStore } from "react";
import * as ReactNative from "react-native";
import RootLayout, { ErrorBoundary } from "@/app/_layout";
import { themeColors } from "@/theme.generated";

const APP_DIR = "./src/app";
const PENDING_COLOR_MIGRATIONS: Record<string, number> = {
  "app/settings/data.tsx": 1,
  "cards/battery-card.tsx": 1,
  "cards/module-card.tsx": 3,
  "hosts/host-row.tsx": 1,
  "lock/app-lock-setting.tsx": 1,
  "widgets/chart-annotations.tsx": 1,
  "widgets/gap-bands.tsx": 1,
  "widgets/inline-bar.tsx": 1,
  "widgets/stack-bar.tsx": 1,
  "widgets/stat-list.tsx": 1,
  "widgets/stream-area.tsx": 3,
};

test("screens inherit navigator colors and use shared theme lookups", () => {
  const root = "./src";
  const sources = readdirSync(root, {
    recursive: true,
    encoding: "utf8",
  }).filter((path) => /\.tsx?$/.test(path));
  const overrides: string[] = [];
  const rawLookups: string[] = [];
  const transportImports: string[] = [];
  for (const path of sources) {
    const source = readFileSync(`${root}/${path}`, "utf8");
    if (/\bheader(?:TintColor|UserInterfaceStyle)\s*:/.test(source))
      overrides.push(path);
    const directLookups = [...source.matchAll(/\bthemeColors\[/g)].length;
    if (
      path !== "ui/theme-colors.ts" &&
      directLookups > (PENDING_COLOR_MIGRATIONS[path] ?? 0)
    )
      rawLookups.push(path);
    if (!path.startsWith("transport/") && /["']@\/transport\//.test(source)) {
      transportImports.push(path);
    }
  }
  expect(overrides).toEqual([]);
  expect(rawLookups).toEqual([]);
  expect(transportImports).toEqual([]);
});

function ThemeReadout() {
  const { dark, colors } = useTheme();
  return (
    <ReactNative.Text>
      {[
        dark,
        colors.text,
        colors.background,
        colors.card,
        colors.border,
        colors.primary,
      ].join(" ")}
    </ReactNative.Text>
  );
}

test("switching appearance updates the navigator theme from the generated tokens", async () => {
  installNative(null);
  let scheme: "light" | "dark" = "light";
  const listeners = new Set<() => void>();
  const listen = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  jest
    .spyOn(ReactNative, "useColorScheme")
    .mockImplementation(() => useSyncExternalStore(listen, () => scheme));
  await renderRouter({ appDir: APP_DIR, overrides: { index: ThemeReadout } });
  function tokens(scheme: "light" | "dark") {
    const { foreground, background, card, border } = themeColors[scheme];
    return [
      scheme === "dark",
      foreground,
      background,
      card,
      border,
      foreground,
    ].join(" ");
  }
  expect(screen.getByText(tokens("light"))).toBeOnTheScreen();
  await act(() => {
    scheme = "dark";
    for (const listener of listeners) listener();
  });
  expect(screen.getByText(tokens("dark"))).toBeOnTheScreen();
});

test.each(["/(hosts)/missing", "/(hosts)/missing/cpu"])(
  "%s opens the welcome screen when there is no transport",
  async (initialUrl) => {
    installNative(null);
    const view = await renderRouter(APP_DIR, { initialUrl });
    expect(
      await screen.findByRole("header", { name: "StatGlass" })
    ).toBeOnTheScreen();
    expect(view.getSegments()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  }
);

test("passes the named demo scenario to the hosts list", async () => {
  installNative(null);
  await renderRouter(APP_DIR, {
    initialUrl: "/demo?scenario=host-unreachable",
  });
  expect(
    await screen.findByRole("button", { name: /^unreachable,/ })
  ).toBeOnTheScreen();
});

test("the root error boundary logs route params once and retries the failed screen", async () => {
  installNative(null);
  const error = new Error("Render interrupted");
  let fails = true;
  function FailingLayout() {
    if (fails) throw error;
    return <RootLayout />;
  }
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  await renderRouter(
    {
      appDir: APP_DIR,
      overrides: { _layout: { default: FailingLayout, ErrorBoundary } },
    },
    { initialUrl: "/some-host/cpu?scenario=phone-errors" }
  );
  expect(
    await screen.findByRole("alert", { name: "This screen couldn’t load" })
  ).toBeOnTheScreen();
  expect(
    log.mock.calls.filter(
      ([message]) => message === "[navigation] screen failed"
    )
  ).toEqual([
    [
      "[navigation] screen failed",
      {
        pathname: "/some-host/cpu",
        host: "some-host",
        module: "cpu",
        scenario: "phone-errors",
        error,
      },
    ],
  ]);
  fails = false;
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("header", { name: "StatGlass" })
  ).toBeOnTheScreen();
});
