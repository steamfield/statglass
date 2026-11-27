import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { HOUR_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { setModuleClock } from "@test/helpers/module-screen";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { ExpoRoot, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import HostsLayout from "@/app/(hosts)/_layout";
import { PhoneSettingsProvider } from "@/data/phone-settings";
import { HostScreen } from "@/host";
import { ModuleScreen } from "@/module";

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "(hosts)/_layout": HostsLayout,
  "(hosts)/index": () => null,
  "(hosts)/[host]/index": HostScreen,
  "(hosts)/[host]/[module]": ModuleScreen,
});

beforeEach(setModuleClock);
afterEach(() => {
  jest.useRealTimers();
});

test("the host and module navigation bars share the selected history window", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const view = await renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  const cpu = await screen.findByRole("button", { name: /^CPU,/ });
  const [rightItem] = view.container.queryAll(
    ({ type, props }) =>
      type === "RNSScreenStackHeaderSubview" &&
      props.type === "right" &&
      props.hidesSharedBackground === true
  );
  if (!rightItem) throw new Error("No native right item for the history range");
  const hostRange = within(rightItem);
  expect(
    hostRange.getByRole("tab", { name: "15m, History range" })
  ).toBeSelected();
  await fireEvent.press(
    hostRange.getByRole("tab", { name: "1h, History range" })
  );
  expect(
    hostRange.getByRole("tab", { name: "1h, History range" })
  ).toBeSelected();
  await fireEvent.press(
    within(cpu).getByText("CPU", { includeHiddenElements: true })
  );

  const fifteenMinutes = await screen.findByRole("tab", {
    name: "15m, History range",
  });
  expect(screen.getByRole("tab", { name: "1h, History range" })).toBeSelected();
  await fireEvent.press(fifteenMinutes);
  await act(() => router.back());
  expect(
    await screen.findByRole("button", { name: /^CPU,/ })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("tab", { name: "15m, History range" })
  ).toBeSelected();
});

test("reselecting the current range closes the sheet without saving settings again", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const write = jest.fn<(value: string) => void>();
  await renderWithProviders(
    <PhoneSettingsProvider storage={{ read: () => null, write }}>
      <ExpoRoot
        context={context}
        location={new URL(`statglass:///${MOCK_HOST_ID}`)}
      />
    </PhoneSettingsProvider>,
    { transport }
  );
  const hour = () => screen.getByRole("tab", { name: "1h, History range" });
  await fireEvent.press(
    await screen.findByRole("tab", { name: "1h, History range" })
  );
  await act(() => jest.advanceTimersByTimeAsync(500));
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(write.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
    chartWindowMs: HOUR_MS,
  });

  await fireEvent.press(hour());
  await act(() => jest.advanceTimersByTimeAsync(500));
  await fireEvent.press(
    screen.getByRole("tab", { name: "More, History range" })
  );
  const current = screen.getByRole("button", { name: "Last 1 hour" });
  expect(current).toBeSelected();
  await fireEvent.press(current);
  expect(screen.queryByRole("header", { name: "History range" })).toBeNull();
  expect(hour()).toBeSelected();
  await act(() => jest.advanceTimersByTimeAsync(500));
  expect(write).toHaveBeenCalledTimes(1);
});
