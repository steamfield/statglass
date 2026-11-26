/** Checks how the chart shows newly loaded readings with Reduce Motion. */
import { POPOVER_CPU_STREAM } from "@core/widget-models/fixtures/charts";
import { expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { StreamArea } from "@/widgets/stream-area";

it("shows the data at once with Reduce Motion", async () => {
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
  const fixture = POPOVER_CPU_STREAM;
  const { rerender } = await renderWithProviders(
    <StreamArea {...fixture} loading />
  );
  const name = fixture.ariaLabel;
  expect(screen.getByRole("image", { name, busy: true })).toBeOnTheScreen();

  // The still renderer completes a reveal immediately even if one is scheduled.
  const timing = jest.spyOn(Reanimated, "withTiming");
  await rerender(<StreamArea {...fixture} loading={false} />);
  const chart = screen.getByRole("image", { name, busy: false });
  const paths = chart.queryAll((element) => element.type === "RNSVGPath");
  expect(paths).toHaveLength(2);
  for (const path of paths) expect(path).toBeVisible();
  expect(timing).not.toHaveBeenCalled();
});
