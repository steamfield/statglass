/**
 * The first-launch screen through the real root layout, providers and router.
 */
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { expect, jest, test } from "@jest/globals";
import {
  act,
  fireEvent,
  renderRouter,
  screen,
  testRouter,
} from "expo-router/testing-library";
import { AppState } from "react-native";

const APP_DIR = "./src/app";

const ACTIONS = [
  { label: "Pair with your Mac", pathname: "/pair" },
  { label: "Add a Linux server", pathname: "/pair-linux" },
  { label: "Try demo hosts", pathname: "/demo" },
];

test("shows the app name, what it does and the three ways in", async () => {
  await renderRouter(APP_DIR, { initialUrl: "/" });

  expect(screen.getByRole("header", { name: "StatGlass" })).toBeOnTheScreen();
  expect(
    screen.getByText(/Watch the Macs and Linux servers you monitor/)
  ).toBeOnTheScreen();
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(ACTIONS.length);
  ACTIONS.forEach(({ label }, index) => {
    expect(screen.getByRole("button", { name: label })).toBe(buttons[index]);
  });
});

test.each(ACTIONS.slice(0, 2))(
  '"$label" opens $pathname, which is not built yet',
  async ({ label, pathname }) => {
    const router = await renderRouter(APP_DIR, { initialUrl: "/" });

    await fireEvent.press(screen.getByRole("button", { name: label }));

    expect(router.getPathname()).toBe(pathname);
    expect(await screen.findByText("Not built yet")).toBeOnTheScreen();
  }
);

test("Try demo hosts replaces the entry route with the demo hosts list", async () => {
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(screen.getByRole("button", { name: "Try demo hosts" }));

  expect(await screen.findByText("Demo")).toBeOnTheScreen();
  expect(router.getSegments()).toEqual(["(hosts)"]);
  expect(
    await screen.findByRole("button", { name: /macOS, Live/ })
  ).toBeOnTheScreen();
});

test("returns to the demo hosts from the Settings navigation bar", async () => {
  const router = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(screen.getByRole("button", { name: "Try demo hosts" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: "Settings" })
  );
  expect(router.getPathname()).toBe("/settings");
  await fireEvent.press(screen.getByRole("button", { name: "Back to Hosts" }));
  expect(router.getSegments()).toEqual(["(hosts)"]);
  expect(await screen.findByText("Demo")).toBeOnTheScreen();
});

test("back from pairing returns to the demo hosts", async () => {
  const view = await renderRouter(APP_DIR, { initialUrl: "/" });
  await fireEvent.press(screen.getByRole("button", { name: "Try demo hosts" }));
  expect(await screen.findByText("Demo")).toBeOnTheScreen();

  await testRouter.push("/pair");
  expect(await screen.findByText("Not built yet")).toBeOnTheScreen();
  await testRouter.back("/");

  expect(view.getSegments()).toEqual(["(hosts)"]);
  expect(await screen.findByText("Demo")).toBeOnTheScreen();
});

test.each(["back navigation", "root unmount"])(
  "demo streams at 1 Hz and clears the ticker on %s",
  async (exit) => {
    const previousAppState = AppState.currentState;
    AppState.currentState = "active";
    const view = await renderRouter(APP_DIR, { initialUrl: "/" });
    const intervals = jest.spyOn(globalThis, "setInterval");
    const clear = jest.spyOn(globalThis, "clearInterval");
    let mounted = true;
    try {
      await fireEvent.press(
        screen.getByRole("button", { name: "Try demo hosts" })
      );
      await screen.findByText("Demo");
      intervals.mockClear();
      await testRouter.push(`/${MOCK_HOST_ID}`);
      expect(await screen.findByText("Connecting")).toBeOnTheScreen();
      const tickers = intervals.mock.results.flatMap(({ value }, index) =>
        intervals.mock.calls[index]?.[1] === 1000 ? [value] : []
      );
      expect(tickers).toHaveLength(1);

      await act(() => jest.advanceTimersByTimeAsync(1000));
      expect(screen.getByText("Live · 1s")).toBeOnTheScreen();
      await act(() => jest.advanceTimersByTimeAsync(4000));
      expect(screen.getByText("Live · 1s")).toBeOnTheScreen();

      if (exit === "back navigation") {
        await testRouter.back("/");
        expect(view.getSegments()).toEqual(["(hosts)"]);
        expect(clear.mock.calls.flat()).not.toContain(tickers[0]);
        await testRouter.back("/");
        expect(
          screen.getByRole("button", { name: "Try demo hosts" })
        ).toBeOnTheScreen();
      } else {
        await view.unmount();
        mounted = false;
      }
      expect(clear.mock.calls.flat()).toContain(tickers[0]);
    } finally {
      if (mounted) await view.unmount();
      AppState.currentState = previousAppState;
      intervals.mockRestore();
      clear.mockRestore();
      jest.useRealTimers();
    }
  }
);
