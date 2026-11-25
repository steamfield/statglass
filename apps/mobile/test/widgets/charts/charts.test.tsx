import { CHART_CAPTION_CHAR_WIDTH_PX } from "@core/widget-models/chart-annotation";
import { POPOVER_CPU_STREAM } from "@core/widget-models/fixtures/charts";
import { streamAreaModel } from "@core/widget-models/stream-area";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import {
  AccessibilityInfo,
  DeviceEventEmitter,
  Dimensions,
  Pressable,
  processColor,
  StyleSheet,
  useColorScheme,
} from "react-native";
import * as Reanimated from "react-native-reanimated";
import { motionDurations, themeColors } from "@/theme.generated";
import { StreamArea } from "@/widgets/stream-area";

afterEach(() => {
  jest.mocked(useColorScheme).mockReturnValue("light");
});

const fixture = POPOVER_CPU_STREAM;
const width = 295;
const { ariaLabel: name, height, tEndMs, intervalMs } = fixture;
const overlayFixture = {
  ...fixture,
  gaps: [{ fromMs: tEndMs - 10_000, toMs: tEndMs + 1, label: "Asleep" }],
  annotations: [
    { tsMs: tEndMs + 1, label: "Outside the plot" },
    { tsMs: tEndMs - 5_000, label: "CPU spike", variant: "pill" as const },
  ],
};

const chart = () => screen.getByRole("img", { name });
const layout = () =>
  fireEvent(chart(), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });

function TickChart() {
  // Another consumer can create a shared value before the chart mounts.
  Reanimated.useSharedValue(1);
  const [index, setIndex] = useState(0);
  const tick = [0, 1, 3, 4, 5][index] ?? 0;
  return (
    <>
      <StreamArea {...fixture} tEndMs={tEndMs + tick * intervalMs} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Advance chart"
        onPress={() => setIndex(index + 1)}
      />
    </>
  );
}

describe("phone chart geometry", () => {
  it.each(["light", "dark"] as const)(
    "renders the model paths, legend captions and %s ink",
    async (scheme) => {
      jest.mocked(useColorScheme).mockReturnValue(scheme);
      await renderWithProviders(<StreamArea {...fixture} />);
      await layout();
      const [series] = streamAreaModel(fixture, { widthPx: width }).series;
      const paths = chart().queryAll((el) => el.type === "RNSVGPath");
      expect(paths.map((path) => path.props.d)).toEqual([
        series?.areaPath,
        series?.linePath,
      ]);
      expect(screen.getByText(fixture.ceilingLabel)).toBeOnTheScreen();
      expect(screen.getByText(fixture.windowLabel)).toBeOnTheScreen();
      expect(paths[1]?.props.stroke).toEqual(
        expect.objectContaining({
          payload: processColor(themeColors[scheme]["cpu-ink"]),
        })
      );
    }
  );

  it("places a clipped and named gap and an in-window annotation after measuring", async () => {
    const { container } = await renderWithProviders(
      <StreamArea {...overlayFixture} />
    );
    expect(screen.queryByText("CPU spike")).toBeNull();
    await layout();
    const model = streamAreaModel(overlayFixture, {
      widthPx: width,
      annotationScale: Dimensions.get("window").fontScale,
    });
    const gap = screen.getByRole("note", { name: "Asleep" });
    const [band] = model.gaps;
    const [rect] = container.queryAll((el) => el.type === "RNSVGRect");
    expect(rect?.props).toMatchObject({
      x: (band?.leftFrac ?? 0) * width,
      width: (band?.widthFrac ?? 0) * width,
      height,
    });
    expect(gap).toHaveTextContent("Asleep");
    const [annotation] = model.annotations;
    const label = screen.getByLabelText("CPU spike");
    expect(label).toHaveTextContent(annotation?.label ?? "");
    expect(label.parent).toHaveStyle({
      maxWidth: annotation?.fitPx,
      right: width - (annotation?.leftPx ?? 0) - (annotation?.fitPx ?? 0),
    });
    expect(screen.queryByText("Outside the plot")).toBeNull();
  });

  it("draws fractional-width gaps in a plot-wide viewport", async () => {
    const { container } = await renderWithProviders(
      <StreamArea
        {...fixture}
        series={[{ key: "cpu", step: 1, values: [1, 2] }]}
        intervalMs={30 * 86_400_000}
        gaps={[
          { fromMs: tEndMs - 600_000, toMs: tEndMs - 300_000, label: "Asleep" },
        ]}
      />
    );
    await layout();
    const viewport = container
      .queryAll((el) => el.type === "RNSVGSvgView")
      .find((svg) => svg.queryAll((el) => el.type === "RNSVGRect").length > 0);
    expect(viewport?.props.bbWidth).toBe("100%");
    const [band] = viewport?.queryAll((el) => el.type === "RNSVGRect") ?? [];
    expect(band?.props.width).toBeGreaterThan(0);
    expect(band?.props.width).toBeLessThan(1);
  });

  it("gives narrow gap captions room for the full reason and pause mark", async () => {
    await renderWithProviders(
      <StreamArea
        {...fixture}
        gaps={[
          {
            fromMs: tEndMs - 51_000,
            toMs: tEndMs - 50_000,
            label: "Recording paused",
            reason: "paused",
          },
        ]}
      />
    );
    await layout();
    const caption = screen.getByText("Recording paused");
    const group = caption.parent;
    const note = group?.parent;
    const captionWidth =
      "Recording paused".length *
        CHART_CAPTION_CHAR_WIDTH_PX *
        Dimensions.get("window").fontScale +
      16 +
      9 +
      4;
    expect(StyleSheet.flatten(note?.props.style)?.width).toBe(captionWidth);
    expect(group?.queryAll((el) => el.type === "RNSVGPath")).toHaveLength(1);
  });

  it("puts colliding gap captions below the plot so both can wrap", async () => {
    await renderWithProviders(
      <StreamArea
        {...fixture}
        gaps={[
          {
            fromMs: tEndMs - 12_000,
            toMs: tEndMs - 11_000,
            label: "Asleep after closing the lid",
          },
          {
            fromMs: tEndMs - 9_000,
            toMs: tEndMs - 8_000,
            label: "Recording was paused",
          },
        ]}
      />
    );
    await layout();
    expect(screen.getAllByRole("note")).toHaveLength(2);
    expect(
      screen.getByText("Asleep after closing the lid").props.numberOfLines
    ).toBeUndefined();
    expect(
      screen.getByText("Recording was paused").props.numberOfLines
    ).toBeUndefined();
  });

  it("keeps the count at the end of a truncated merged annotation", async () => {
    await renderWithProviders(
      <StreamArea
        {...fixture}
        annotations={["First event", "Second event", "Third event"].map(
          (label) => ({
            tsMs: tEndMs - 12_000,
            label,
          })
        )}
      />
    );
    await layout();
    expect(screen.getByLabelText("First event +1")).toHaveProp(
      "ellipsizeMode",
      "middle"
    );
  });

  it("keeps the last sample's whole hollow dot inside the SVG drawable area", async () => {
    const { container } = await renderWithProviders(
      <StreamArea
        {...fixture}
        series={[{ key: "cpu", step: 1, values: [fixture.yMax] }]}
      />
    );
    await layout();
    const viewport = container
      .queryAll((el) => el.type === "RNSVGSvgView")
      .find(
        (svg) => svg.queryAll((el) => el.type === "RNSVGCircle").length > 0
      );
    const [dot] = viewport?.queryAll((el) => el.type === "RNSVGCircle") ?? [];
    expect(Number(dot?.props.cx) + 3.5).toBeLessThanOrEqual(
      Number(viewport?.props.bbWidth)
    );
    expect(Number(dot?.props.cy)).toBeGreaterThanOrEqual(3.5);
  });
});

describe("phone chart states and motion", () => {
  it("keeps the frame busy while history loads and hides the marks", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(true);
    const repeat = jest.spyOn(Reanimated, "withRepeat");
    await renderWithProviders(<StreamArea {...overlayFixture} loading />);
    await layout();
    expect(screen.getByRole("img", { name, busy: true })).toBeOnTheScreen();
    expect(chart().queryAll((el) => el.type === "RNSVGPath")).toHaveLength(0);
    const rules = chart().queryAll((el) => el.type === "RNSVGLine");
    expect(rules).toHaveLength(3);
    expect(rules.at(-1)?.props.stroke).toEqual(
      expect.objectContaining({
        payload: processColor(themeColors.light["cpu-ink"]),
      })
    );
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("CPU spike")).toBeNull();
    expect(repeat).not.toHaveBeenCalled();
  });

  it("scans the loading baseline and cancels that animation on unmount", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
    const repeat = jest.spyOn(Reanimated, "withRepeat");
    const delay = jest.spyOn(Reanimated, "withDelay");
    const timing = jest.spyOn(Reanimated, "withTiming");
    const cancel = jest.spyOn(Reanimated, "cancelAnimation");
    const { unmount } = await renderWithProviders(
      <StreamArea {...fixture} loading />
    );
    await layout();
    expect(timing).toHaveBeenCalledWith(
      width,
      expect.objectContaining({ duration: motionDurations.scan })
    );
    expect(repeat).toHaveBeenCalledWith(
      width,
      -1,
      false,
      undefined,
      Reanimated.ReduceMotion.Never
    );
    expect(delay).toHaveBeenCalledWith(
      motionDurations.fast,
      width,
      Reanimated.ReduceMotion.Never
    );
    await unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("multiplies gradient opacity by the series ramp step", async () => {
    const [cpu] = fixture.series;
    if (!cpu) throw new Error("CPU fixture has no series");
    await renderWithProviders(
      <StreamArea {...fixture} series={[{ ...cpu, step: 2 }]} />
    );
    const [gradient] = chart().queryAll(
      (el) => el.type === "RNSVGLinearGradient"
    );
    expect(gradient?.props.gradient).toEqual([0, 0x3d06b6d4, 1, 0x0006b6d4]);
  });

  it("leaves the chart frame empty when a series has no readings", async () => {
    await renderWithProviders(
      <StreamArea
        {...fixture}
        series={[{ key: "cpu", step: 1, values: [null, null] }]}
      />
    );
    await layout();
    expect(chart().queryAll((el) => el.type === "RNSVGPath")).toHaveLength(0);
    expect(chart().queryAll((el) => el.type === "RNSVGLine")).toHaveLength(2);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("scrolls on the next tick and stops on gaps and when Reduce Motion is turned on", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
    jest
      .mocked(AccessibilityInfo.addEventListener)
      .mockImplementationOnce((event, handler) =>
        DeviceEventEmitter.addListener(event, handler)
      );
    const timing = jest.spyOn(Reanimated, "withTiming");
    const sharedValues = jest.spyOn(Reanimated, "useSharedValue");
    await renderWithProviders(<TickChart />);
    const advance = () =>
      fireEvent.press(screen.getByRole("button", { name: "Advance chart" }));
    await layout();
    expect(timing).not.toHaveBeenCalled();
    const translationIndex = sharedValues.mock.calls.findIndex(
      ([initial]) => initial === 0
    );
    const translation = sharedValues.mock.results[translationIndex];
    if (translation?.type !== "return") throw new Error("No chart translation");
    const setTranslation = jest.spyOn(translation.value, "set");
    await advance();
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ duration: motionDurations.tick })
    );
    expect(setTranslation.mock.calls).toEqual([[5], [0]]);
    timing.mockClear();
    await advance();
    expect(timing).not.toHaveBeenCalled();
    await act(() => DeviceEventEmitter.emit("reduceMotionChanged", true));
    await advance();
    expect(timing).not.toHaveBeenCalled();
    await act(() => DeviceEventEmitter.emit("reduceMotionChanged", false));
    await advance();
    expect(timing).toHaveBeenCalledTimes(1);
  });
});
