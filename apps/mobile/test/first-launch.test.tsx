/**
 * The first-launch screen through the real root layout, providers and router.
 */
import { expect, test } from "@jest/globals";
import { fireEvent, renderRouter, screen } from "expo-router/testing-library";

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
  expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual(
    ACTIONS.map((action) => action.label)
  );
});

test.each(ACTIONS)(
  '"$label" opens $pathname, which is not built yet',
  async ({ label, pathname }) => {
    const router = await renderRouter(APP_DIR, { initialUrl: "/" });

    await fireEvent.press(screen.getByRole("button", { name: label }));

    expect(router.getPathname()).toBe(pathname);
    expect(await screen.findByText("Not built yet")).toBeOnTheScreen();
  }
);
