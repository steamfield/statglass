import { expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent } from "@testing-library/react-native";
import * as Battery from "expo-battery";
import { useState } from "react";
import { AccessibilityInfo } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { SegmentedControl } from "@/ui/segmented-control";

const segments = [
  { value: 5, label: "5 min" },
  { value: 60, label: "1 hour" },
  { value: 1440, label: "24 hours" },
] as const;

it.each([
  { reduceMotion: false, lowPowerMode: false },
  { reduceMotion: true, lowPowerMode: false },
  { reduceMotion: false, lowPowerMode: true },
])(
  "selects the tab and moves the thumb (Reduce Motion $reduceMotion, Low Power Mode $lowPowerMode)",
  async ({ reduceMotion, lowPowerMode }) => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(reduceMotion);
    jest
      .spyOn(Battery, "isLowPowerModeEnabledAsync")
      .mockResolvedValue(lowPowerMode);
    function RangePicker() {
      const [range, setRange] = useState<number>(60);
      return (
        <SegmentedControl<number>
          accessibilityLabel="Range"
          segments={segments}
          value={range}
          onChange={setRange}
        />
      );
    }

    const view = await renderWithProviders(<RangePicker />);
    const track = view.getByLabelText("Range");
    expect(track.props.accessibilityRole).toBe("tablist");
    await fireEvent(track, "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } },
    });
    expect(
      view.getByRole("tab", { name: "1 hour, Range", selected: true })
    ).toBeVisible();
    expect(view.getByTestId("segment-thumb")).toHaveStyle({
      width: 100,
      transform: [{ translateX: 100 }],
    });
    // The still renderer lands every animation on its final position.
    const timing =
      reduceMotion || lowPowerMode
        ? jest.spyOn(Reanimated, "withTiming")
        : undefined;

    const last = view.getByRole("tab", {
      name: "24 hours, Range",
      selected: false,
    });
    await fireEvent.press(last);
    expect(
      view.getByRole("tab", { name: "24 hours, Range", selected: true })
    ).toBeVisible();
    expect(
      view.getByRole("tab", { name: "1 hour, Range", selected: false })
    ).toBeVisible();
    // The shared Jest stand-in reads animated styles only during a React render.
    await view.rerender(<RangePicker />);
    expect(view.getByTestId("segment-thumb")).toHaveStyle({
      width: 100,
      transform: [{ translateX: 200 }],
    });
    if (timing) expect(timing).not.toHaveBeenCalled();
  }
);

it("allows a selection when the current value is absent and draws no thumb until then", async () => {
  const onChange = jest.fn<(value: number) => void>();
  function RangePicker() {
    const [range, setRange] = useState(0);
    return (
      <SegmentedControl<number>
        accessibilityLabel="Range"
        segments={segments}
        value={range}
        onChange={(next) => {
          onChange(next);
          setRange(next);
        }}
      />
    );
  }

  const view = await renderWithProviders(<RangePicker />);
  await fireEvent(view.getByLabelText("Range"), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } },
  });
  expect(view.queryByRole("tab", { selected: true })).toBeNull();
  expect(view.queryByTestId("segment-thumb")).toBeNull();
  await fireEvent.press(view.getByRole("tab", { name: /^1 hour/ }));
  expect(onChange.mock.calls).toEqual([[60]]);
  expect(
    view.getByRole("tab", { name: "1 hour, Range", selected: true })
  ).toBeVisible();
  expect(view.getByTestId("segment-thumb")).toHaveStyle({
    transform: [{ translateX: 100 }],
  });
});
