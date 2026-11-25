import { MISSING } from "@core/format";
import {
  INLINE_BAR,
  MEMORY_STACK,
  POWER_STAT_GRID,
} from "@core/widget-models/fixtures/bars";
import { mirrorBarsModel } from "@core/widget-models/mirror-bars";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import * as ReactNative from "react-native";
import { themeColors } from "@/theme.generated";
import { InlineBar } from "@/widgets/inline-bar";
import { BarFill, MeterTrack, WidgetAccent } from "@/widgets/meter-track";
import { MirrorBars } from "@/widgets/mirror-bars";
import { StackBar } from "@/widgets/stack-bar";
import { StatList } from "@/widgets/stat-list";

test("draws the memory composition with its named slices and swap legend", async () => {
  await renderWithProviders(<StackBar {...MEMORY_STACK} />);
  const bar = screen.getByRole("image", {
    name: "Wired 3.9 GB, App 11.6 GB, Compressed 2.1 GB, Cached files 4.0 GB, Free 2.4 GB",
  });
  expect(screen.getAllByTestId("stack-segment")).toHaveLength(5);
  expect(screen.getAllByTestId("stack-segment")[0]).toHaveStyle({
    flexGrow: 3.9 / 24,
  });
  expect(bar).toBeOnTheScreen();
  expect(screen.getByText("Swap")).toBeOnTheScreen();
  expect(screen.getByText("512 MB")).toBeOnTheScreen();
});

test("shows an empty stack and leaves its missing values in the legend", async () => {
  await renderWithProviders(
    <StackBar
      {...MEMORY_STACK}
      segments={MEMORY_STACK.segments.map((segment) => ({
        ...segment,
        value: MISSING,
        fraction: null,
      }))}
    />
  );
  expect(screen.getByRole("image", { name: /Wired —/ })).toBeOnTheScreen();
  expect(screen.getByTestId("empty-stack")).toBeOnTheScreen();
  expect(screen.queryAllByTestId("stack-segment")).toHaveLength(0);
  expect(screen.getByText("Compressed")).toBeOnTheScreen();
  expect(screen.getAllByText(MISSING)).toHaveLength(5);
});

test("draws the inline fill width, preserves a missing track and omits a meaningless one", async () => {
  const { rerender } = await renderWithProviders(<InlineBar {...INLINE_BAR} />);
  expect(screen.getByText("3.2 GHz")).toBeOnTheScreen();
  expect(
    screen.getByTestId("meter-fill", { includeHiddenElements: true })
  ).toHaveStyle({
    width: "71%",
  });

  await rerender(<InlineBar {...INLINE_BAR} value={MISSING} fraction={null} />);
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
  expect(
    screen.getByTestId("meter-track", { includeHiddenElements: true })
  ).toBeOnTheScreen();
  expect(
    screen.queryByTestId("meter-fill", { includeHiddenElements: true })
  ).toBeNull();

  await rerender(
    <InlineBar {...INLINE_BAR} value="Passive cooling" fraction="none" />
  );
  expect(screen.getByText("Passive cooling")).toBeOnTheScreen();
  expect(
    screen.queryByTestId("meter-track", { includeHiddenElements: true })
  ).toBeNull();
});

test("keeps the standalone meter visible and decorative when no sample exists", async () => {
  await renderWithProviders(<MeterTrack fraction={null} />);
  expect(
    screen.getByTestId("meter-track", { includeHiddenElements: true })
  ).toBeOnTheScreen();
  expect(screen.queryByTestId("meter-track")).toBeNull();
  expect(
    screen.queryByTestId("meter-fill", { includeHiddenElements: true })
  ).toBeNull();
});

test.each(["light", "dark"] as const)(
  "paints the battery ink ramp in the %s theme",
  async (scheme) => {
    jest.spyOn(ReactNative, "useColorScheme").mockReturnValue(scheme);
    await renderWithProviders(
      <WidgetAccent value="battery">
        <BarFill
          className="h-1"
          color={{ kind: "accent", ink: true, step: 2 }}
          testID="battery-ink"
        />
      </WidgetAccent>
    );
    expect(screen.getByTestId("battery-ink")).toHaveStyle({
      backgroundColor: `${themeColors[scheme]["battery-ink"]}99`,
    });
  }
);

test("rejects a measured meter without an accent in scope", async () => {
  await expect(
    renderWithProviders(<MeterTrack fraction={0.5} />)
  ).rejects.toThrow("the color names no accent and none is in scope");
});

test("puts the meter below the label and figure at accessibility text sizes", async () => {
  jest.spyOn(ReactNative, "useWindowDimensions").mockReturnValue({
    width: 440,
    height: 956,
    scale: 3,
    fontScale: 2.35,
  });
  await renderWithProviders(<InlineBar {...INLINE_BAR} layout="row" />);
  expect(screen.getByTestId("inline-bar-layout")).toHaveStyle({
    flexDirection: "column",
  });
  expect(screen.getByText("P-cluster")).toBeOnTheScreen();
  expect(screen.getByText("3.2 GHz")).toBeOnTheScreen();
});

const net = {
  up: [4, null, 0],
  down: [null, 10, null],
  upMax: 8,
  downMax: 10,
  intervalMs: 1000,
  accent: "net",
  ariaLabel: "Network, upload above the line, download below",
} as const;

test("places measured mirrored bars in their model slots and leaves gaps empty", async () => {
  const data = net;
  const model = mirrorBarsModel(data);
  const { rerender } = await renderWithProviders(<MirrorBars {...data} />);
  expect(
    screen.getByRole("image", { name: model.ariaLabel })
  ).toBeOnTheScreen();
  const marks = screen.getAllByTestId("mirror-bar");
  expect(marks).toHaveLength(3);
  expect(marks[0]).toHaveStyle({ height: model.up[0] });
  expect(marks[1]).toHaveStyle({ height: model.up[2] });
  expect(marks[2]).toHaveStyle({ height: model.down[1] });
  expect(marks[0]?.parent).toHaveProp(
    "className",
    expect.stringContaining("gap-0.5")
  );
  expect(marks[2]?.parent).toHaveProp(
    "className",
    expect.stringContaining("gap-0.5")
  );
  expect(
    screen.getAllByTestId(/mirror-(bar|gap)/).map((slot) => slot.props.testID)
  ).toEqual([
    "mirror-bar",
    "mirror-gap",
    "mirror-bar",
    "mirror-gap",
    "mirror-bar",
    "mirror-gap",
  ]);

  await rerender(<MirrorBars {...data} loading />);
  expect(
    screen.getByRole("image", { name: model.ariaLabel, busy: true })
  ).toBeOnTheScreen();
  expect(screen.queryAllByTestId("mirror-bar")).toHaveLength(0);
  expect(screen.getByTestId("mirror-loading")).toHaveStyle({
    backgroundColor: themeColors.light.net,
    height: "100%",
  });
});

function LiveBars() {
  const [tEndMs, setEnd] = useState(1000);
  return (
    <>
      <MirrorBars {...net} tEndMs={tEndMs} />
      <ReactNative.Button
        title="Next sample"
        onPress={() => setEnd(tEndMs + 1000)}
      />
      <ReactNative.Button
        title="Jump ahead"
        onPress={() => setEnd(tEndMs + 3000)}
      />
    </>
  );
}

test.each([false, true])(
  "scrolls consecutive live slots with Reduce Motion set to %s",
  async (reduced) => {
    jest
      .spyOn(ReactNative.AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(reduced);
    const start = jest.fn();
    const timing = jest.spyOn(ReactNative.Animated, "timing").mockReturnValue({
      start,
      stop: jest.fn(),
      reset: jest.fn(),
    });
    await renderWithProviders(<LiveBars />);
    await fireEvent(
      screen.getByRole("image", { name: net.ariaLabel }),
      "layout",
      {
        nativeEvent: { layout: { width: 120 } },
      }
    );
    expect(start).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Next sample" }));
    if (reduced) {
      expect(timing).not.toHaveBeenCalled();
      return;
    }
    expect(timing).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole("button", { name: "Jump ahead" }));
    expect(start).toHaveBeenCalledTimes(1);
  }
);

test("prints the power stat grid including a measured zero", async () => {
  jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("light");
  await renderWithProviders(<StatList {...POWER_STAT_GRID} />);
  for (const item of POWER_STAT_GRID.items) {
    expect(screen.getByText(item.label)).toBeOnTheScreen();
    expect(screen.getByText(item.value)).toBeOnTheScreen();
  }
  const colors = themeColors.light;
  expect(screen.getByText("6.4 W")).toHaveStyle({ color: colors.foreground });
  expect(screen.getByText("0.0 W")).toHaveStyle({
    color: colors["muted-foreground"],
  });
});
