import "react-native-gesture-handler/jestSetup";
import { expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { ExpoRoot, Stack } from "expo-router";
import { fireEvent, getMockContext, screen } from "expo-router/testing-library";
import PrimitivesRoute from "@/app/dev/primitives";
import { Text } from "@/ui/text";

jest.mock(
  "react-native-reanimated",
  () => require("./reanimated-list-stub").reanimatedListStub
);

const routes = getMockContext({
  _layout: () => <Stack />,
  index: () => <Text variant="title">First launch</Text>,
  "dev/primitives": PrimitivesRoute,
});

it("shows the primitive gallery at a development deep link", async () => {
  await renderWithProviders(
    <ExpoRoot context={routes} location="/dev/primitives" />
  );
  expect(screen.getByText("Grouped list")).toBeVisible();
  expect(screen.getByText("24 hours")).toBeVisible();
  expect(screen.getByText("Axis ticks")).toBeVisible();
  expect(screen.getByLabelText("CPU, last 60 seconds, 18%")).toBeVisible();

  await fireEvent.press(screen.getByRole("button", { name: "Open sheet" }));
  expect(screen.getByRole("header", { name: "Preview sheet" })).toBeVisible();
});

it("redirects the primitives deep link in a release build", async () => {
  const runtime = globalThis as typeof globalThis & { __DEV__: boolean };
  const dev = jest.replaceProperty(runtime, "__DEV__", false);
  try {
    await renderWithProviders(
      <ExpoRoot context={routes} location="/dev/primitives" />
    );
    expect(
      await screen.findByRole("header", { name: "First launch" })
    ).toBeVisible();
    expect(screen.queryByText("Grouped list")).toBeNull();
  } finally {
    dev.restore();
  }
});
