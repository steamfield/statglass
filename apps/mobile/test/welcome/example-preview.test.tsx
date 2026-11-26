import type { LiveMsg } from "@core/generated/types";
import * as Mock from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import * as Battery from "expo-battery";
import { Stack } from "expo-router";
import {
  act,
  fireEvent,
  renderRouter,
  screen,
  testRouter,
} from "expo-router/testing-library";
import { AccessibilityInfo, AppState } from "react-native";
import { AppProviders } from "@/lib/providers";
import { DemoProvider } from "@/session/demo";
import { Text } from "@/ui/text";
import { ExamplePreview, WelcomeScreen } from "@/welcome/welcome-screen";

const previousAppState = AppState.currentState;

beforeEach(() => {
  jest.useFakeTimers();
  AppState.currentState = "active";
});

afterEach(() => {
  AppState.currentState = previousAppState;
  jest.useRealTimers();
});

function observeFixture() {
  const createMock = Mock.createMockTransport;
  const frames =
    jest.fn<(message: Extract<LiveMsg, { kind: "frame" }>) => void>();
  const fixtures = jest
    .spyOn(Mock, "createMockTransport")
    .mockImplementation((options) => {
      const mock = createMock(options);
      const subscribe = mock.subscribeLive;
      jest
        .spyOn(mock, "subscribeLive")
        .mockImplementation((host, receive, request) =>
          subscribe(
            host,
            (message) => {
              if (message.kind === "frame") frames(message);
              receive(message);
            },
            request
          )
        );
      return mock;
    });
  return {
    frames,
    subscribers() {
      const fixture = fixtures.mock.results[0];
      return fixture?.type === "return" ? fixture.value.subscriberCount() : 0;
    },
  };
}

function Routes() {
  return (
    <AppProviders>
      <DemoProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </DemoProvider>
    </AppProviders>
  );
}

test("shows one accessible example and stops delivering frames while blurred", async () => {
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(false);
  const { frames, subscribers } = observeFixture();
  await renderRouter({
    _layout: Routes,
    index: WelcomeScreen,
    pair: () => <Text variant="title">Pairing</Text>,
    "(hosts)/index": () => null,
  });
  expect(screen.getAllByLabelText(/^Example host:/)).toHaveLength(1);
  const initialLabel =
    "Example host: CPU 18%, memory 17.6 GB of 24 GB, network 38.4 MB/s down";
  expect(screen.getByLabelText(initialLabel)).toBeOnTheScreen();
  expect(
    screen.queryByRole("button", { name: /CPU|Memory|Network/ })
  ).toBeNull();
  for (const metric of ["CPU", "Memory", "Network"]) {
    expect(
      screen.getByText(metric, { includeHiddenElements: true })
    ).toBeOnTheScreen();
  }
  expect(subscribers()).toBe(1);
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(frames).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText(initialLabel)).toBeNull();

  await fireEvent.press(screen.getByRole("button", { name: "Add a host" }));
  expect(screen.getByRole("header", { name: "Pairing" })).toBeOnTheScreen();
  expect(subscribers()).toBe(0);
  await act(() => jest.advanceTimersByTimeAsync(5000));
  expect(frames).toHaveBeenCalledTimes(1);

  await testRouter.back("/");
  expect(subscribers()).toBe(1);
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(frames).toHaveBeenCalledTimes(2);
});

test.each(["Reduce Motion", "Low Power Mode"])(
  "shows one still frame in %s",
  async (preference) => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(preference === "Reduce Motion");
    jest
      .spyOn(Battery, "isLowPowerModeEnabledAsync")
      .mockResolvedValue(preference === "Low Power Mode");
    const { frames, subscribers } = observeFixture();
    await renderWithProviders(<ExamplePreview focused />);
    expect(
      screen.getByText("18%", { includeHiddenElements: true })
    ).toBeOnTheScreen();
    expect(subscribers()).toBe(0);

    await act(() => jest.advanceTimersByTimeAsync(5000));
    expect(
      screen.getByText("18%", { includeHiddenElements: true })
    ).toBeOnTheScreen();
    expect(frames).not.toHaveBeenCalled();
  }
);
