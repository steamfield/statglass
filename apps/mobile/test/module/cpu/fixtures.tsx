import type { HostHistoryPage, SeriesKey } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import type { MockTransport } from "@core/mock-transport";
import { seriesKeyString } from "@core/series-key";
import { expect, jest } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import { ModuleScreen } from "@/module";

const context = getMockContext({
  _layout: () => <Stack />,
  "[host]/[module]": ModuleScreen,
});

export function setModuleClock() {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 24, 15, 2) });
  mockAppState();
}

export function openModule(transport: MockTransport, module: "cpu" | "gpu") {
  return renderWithProviders(
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${MOCK_HOST_ID}/${module}`)}
    />,
    { transport }
  );
}

export async function layoutChart(testId = "history-plot-layout") {
  await fireEvent(await screen.findByTestId(testId), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
}

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
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    await act(() => jest.advanceTimersByTimeAsync(1000));
    await act(() => transport.tick());
    expect(frame).toBe(true);
    return held;
  };
}

export function reading(held: Record<string, number | null>, key: string) {
  const value = held[key];
  if (value == null) throw new Error(`Expected a live reading for ${key}`);
  return value;
}

export function expectStat(label: string, text: string) {
  expect(screen.getByLabelText(label)).toHaveAccessibilityValue({ text });
}
