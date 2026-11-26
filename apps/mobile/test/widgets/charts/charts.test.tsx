import { CHART_CAPTION_CHAR_WIDTH_PX } from "@core/widget-models/chart-annotation";
import { POPOVER_CPU_STREAM } from "@core/widget-models/fixtures/charts";
import {
  type StreamAreaSeries,
  streamAreaModel,
} from "@core/widget-models/stream-area";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen } from "@testing-library/react-native";
import {
  AccessibilityInfo,
  DeviceEventEmitter,
  Dimensions,
  processColor,
  StyleSheet,
  useColorScheme,
} from "react-native";
import * as Reanimated from "react-native-reanimated";
import { themeColors } from "@/theme.generated";
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

  it.each(["chart", "spark"] as const)(
    "puts the %s ceiling on the top gridline without changing the plot height or spoken value",
    async (variant) => {
      const plotHeight = variant === "spark" ? 36 : height;
      await renderWithProviders(
        <StreamArea {...fixture} variant={variant} height={plotHeight} />
      );
      const plot = chart();
      const ceiling = screen.getByText(fixture.ceilingLabel);
      const rules = plot.queryAll((el) => el.type === "RNSVGLine");
      const top = Math.min(...rules.map((rule) => Number(rule.props.y1)));
      expect(top).toBe(1);
      expect(ceiling).toHaveStyle({
        fontVariant: ["tabular-nums"],
        fontSize: 11,
      });
      const background = StyleSheet.flatten(
        ceiling.props.style
      )?.backgroundColor;
      expect(background ?? "transparent").toBe("transparent");
      expect(ceiling).toHaveProp("maxFontSizeMultiplier", 1.5);
      expect(plot).toHaveStyle({ height: plotHeight });
      if (variant === "spark") {
        expect(rules).toHaveLength(1);
        expect(screen.queryByText(fixture.windowLabel)).toBeNull();
        const [area, line] = plot.queryAll((el) => el.type === "RNSVGPath");
        const [series] = streamAreaModel(
          { ...fixture, height: plotHeight },
          {
            widthPx: 0,
          }
        ).series;
        expect(area?.props.d).toBe(series?.areaPath);
        expect(line?.props.d).toBe(series?.linePath);
        expect(line?.props.stroke).toEqual(
          expect.objectContaining({
            payload: processColor(themeColors.light["cpu-ink"]),
          })
        );
      }
    }
  );

  it("draws a top reference for a zero ceiling even when zero is also a grid tick", async () => {
    await renderWithProviders(
      <StreamArea {...fixture} yMax={0} gridlines={[0]} ceilingLabel="0%" />
    );
    expect(screen.getByText("0%")).toBeOnTheScreen();
    const rules = chart().queryAll((el) => el.type === "RNSVGLine");
    expect(Math.min(...rules.map((rule) => Number(rule.props.y1)))).toBe(1);
  });

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
  it("draws a loading scan segment and stops the scan on unmount", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
    const cancel = jest.spyOn(Reanimated, "cancelAnimation");
    const { unmount } = await renderWithProviders(
      <StreamArea {...fixture} loading />
    );
    await layout();
    const plot = screen.getByRole("image", { name, busy: true });
    const [segment] = plot.queryAll(
      (element) =>
        StyleSheet.flatten(element.props.style)?.backgroundColor ===
        themeColors.light["cpu-ink"]
    );
    expect(segment).toBeVisible();
    // The scan repeats forever, so leaving the screen has to cancel it.
    await unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("shows a static loading baseline and hides readings and marks with Reduce Motion", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(true);
    const repeat = jest.spyOn(Reanimated, "withRepeat");
    await renderWithProviders(<StreamArea {...overlayFixture} loading />);
    await layout();
    expect(screen.getByRole("img", { name, busy: true })).toBeOnTheScreen();
    expect(chart().queryAll((el) => el.type === "RNSVGPath")).toHaveLength(0);
    const rules = chart().queryAll((el) => el.type === "RNSVGLine");
    expect(rules).toHaveLength(4);
    expect(rules.at(-1)?.props.stroke).toEqual(
      expect.objectContaining({
        payload: processColor(themeColors.light["cpu-ink"]),
      })
    );
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("CPU spike")).toBeNull();
    expect(repeat).not.toHaveBeenCalled();
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
    expect(chart().queryAll((el) => el.type === "RNSVGLine")).toHaveLength(3);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the next tick without scrolling when Reduce Motion is turned on", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
    jest
      .mocked(AccessibilityInfo.addEventListener)
      .mockImplementationOnce((event, handler) =>
        DeviceEventEmitter.addListener(event, handler)
      );
    const cpu: StreamAreaSeries = { key: "cpu", step: 1, values: [0, 0] };
    const { rerender } = await renderWithProviders(
      <StreamArea {...fixture} series={[cpu]} />
    );
    await layout();
    const line = () =>
      chart()
        .queryAll((el) => el.type === "RNSVGPath")
        .at(-1);
    const previousLine = line();
    expect(previousLine).toBeVisible();
    const previousPath = previousLine?.props.d;

    await act(() => DeviceEventEmitter.emit("reduceMotionChanged", true));
    // The still renderer snaps to the same position even if scrolling runs.
    const timing = jest.spyOn(Reanimated, "withTiming");
    await rerender(
      <StreamArea
        {...fixture}
        series={[{ ...cpu, values: [0, fixture.yMax] }]}
        tEndMs={tEndMs + intervalMs}
      />
    );
    const updatedLine = line();
    expect(updatedLine).toBeVisible();
    expect(updatedLine).not.toHaveProp("d", previousPath);
    expect(timing).not.toHaveBeenCalled();
  });
});
