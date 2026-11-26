/** Render module pages and drive their chart and live-stream inputs in Jest. */
import type { HostHistoryPage, SeriesKey } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import type { MockTransport } from "@core/mock-transport";
import { seriesKeyString } from "@core/series-key";
import { expect, jest } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, Link, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import { ModuleScreen } from "@/module";
import { Text } from "@/ui/text";

const context = getMockContext({
  _layout: () => <Stack />,
  "(hosts)/[host]/[module]": ModuleScreen,
  settings: () => <Link href="/">Elsewhere</Link>,
  elsewhere: () => <Text variant="body">Another screen</Text>,
});

/** The fake clock's starting time, also used by timestamped fixtures. */
export const MODULE_TEST_NOW = Date.UTC(2026, 10, 24, 15, 2);

/** Start the fake clock with the app in the foreground. */
export function setModuleClock() {
  jest.useFakeTimers({ now: MODULE_TEST_NOW });
  mockAppState();
}

/** Open a module link under the real providers, on the local mock host by default. */
export function openModule(
  transport: MockTransport,
  module: string,
  host = MOCK_HOST_ID
) {
  return renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${host}/${module}`)}
    />,
    { transport }
  );
}

/**
 * Give a chart its measured width and, when required, height.
 * @throws If a test ID does not identify exactly one chart.
 */
export async function layoutChart(
  chart: string | Parameters<typeof fireEvent>[0] = "history-plot-layout",
  width = 300,
  height?: number
) {
  const target =
    typeof chart === "string" ? await screen.findByTestId(chart) : chart;
  await fireEvent(target, "layout", {
    nativeEvent: { layout: { width, height } },
  });
}

/** Observe the app's history requests and their successful replies. */
export function watchHistory(transport: MockTransport) {
  const original = transport.hostHistory.bind(transport);
  const replies: HostHistoryPage[] = [];
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      const reply = await original(request);
      if (reply.status === "ok") replies.push(reply.data);
      return reply;
    });
  return { read, replies };
}

/**
 * Wait for the module's local mock subscription before driving live ticks.
 * @throws If the mock never has exactly one live subscriber.
 */
export async function waitForLiveSubscriber(transport: MockTransport) {
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
}

/**
 * Capture held readings from the same live frame the module gets.
 * @returns A function that advances one mock tick and reads its held values.
 * @throws If the module does not subscribe or no frame has arrived.
 */
export function watchHeld(transport: MockTransport) {
  const original = transport.subscribeLive.bind(transport);
  const layouts = new Map<number, SeriesKey[]>();
  let held: Record<string, number | null> = {};
  let frame = false;
  jest
    .spyOn(transport, "subscribeLive")
    .mockImplementation((host, emit, options) =>
      original(
        host,
        (msg) => {
          if (msg.kind === "layout") layouts.set(msg.layout_no, msg.series);
          if (msg.kind === "frame") {
            held = Object.fromEntries(
              (layouts.get(msg.layout_no) ?? []).map((key, i) => [
                seriesKeyString(key),
                msg.held[i] ?? null,
              ])
            );
            frame = true;
          }
          emit(msg);
        },
        options
      )
    );
  return async () => {
    await waitForLiveSubscriber(transport);
    await act(() => jest.advanceTimersByTimeAsync(1000));
    await act(() => transport.tick());
    expect(frame).toBe(true);
    return held;
  };
}

/**
 * Read a measured value from the captured frame.
 * @throws If the series has no held reading.
 */
export function reading(held: Record<string, number | null>, key: string) {
  const value = held[key];
  if (value == null) throw new Error(`Expected a live reading for ${key}`);
  return value;
}

/**
 * Check the value VoiceOver reads for a statistic.
 * @throws If the statistic is missing or its accessible value differs.
 */
export function expectStat(label: string, text: string) {
  expect(screen.getByLabelText(label)).toHaveAccessibilityValue({ text });
}
