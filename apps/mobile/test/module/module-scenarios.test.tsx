/** Visible module-page states driven by named mock scenarios. */
import { createMockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  layoutChart,
  openModule,
  setModuleClock,
} from "@test/helpers/module-screen";
import { screen } from "@testing-library/react-native";

beforeEach(setModuleClock);
afterEach(() => {
  jest.useRealTimers();
});

test("names the host's sleep gap on the history chart", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["sleep-gap"],
  });
  await openModule(transport, "cpu");
  await layoutChart();
  await layoutChart("history-chart-plot");
  expect(
    await screen.findByRole("note", { name: "Asleep 29 min · no samples" })
  ).toBeOnTheScreen();
});

test.each([
  ["history-corrupt", "The history file is damaged. Live values still work."],
  [
    "history-too-new",
    "History was written by a newer version of StatGlass (format 4; this version reads up to 2). Live values still work.",
  ],
] as const)(
  "%s explains why history is unavailable",
  async (scenario, copy) => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: [scenario],
    });
    await openModule(transport, "cpu");
    await layoutChart();
    expect(await screen.findByText(copy)).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeOnTheScreen();
  }
);
