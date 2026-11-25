import { POPOVER_CPU_STREAM } from "@core/widget-models/fixtures/charts";
import { describe, expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { motionDurations } from "@/theme.generated";
import { StreamArea } from "@/widgets/stream-area";

const fixture = POPOVER_CPU_STREAM;

/** Calls that settle the data layer: opacity and height to 1 over the enter token. */
function reveals(timing: ReturnType<typeof jest.spyOn>) {
  return timing.mock.calls.filter(
    ([target, config]) =>
      target === 1 &&
      (config as { duration?: number } | undefined)?.duration ===
        motionDurations.enter
  ).length;
}

async function motionAllowed(allowed: boolean) {
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(!allowed);
}

describe("chart reveal (D-133)", () => {
  it("settles the data in once when its history arrives", async () => {
    await motionAllowed(true);
    const timing = jest.spyOn(Reanimated, "withTiming");
    const { rerender } = await renderWithProviders(
      <StreamArea {...fixture} loading />
    );
    expect(reveals(timing)).toBe(0);

    await act(() => rerender(<StreamArea {...fixture} loading={false} />));
    expect(reveals(timing)).toBe(1);

    // Later ticks with data do not replay it.
    await act(() =>
      rerender(
        <StreamArea
          {...fixture}
          loading={false}
          tEndMs={fixture.tEndMs + fixture.intervalMs}
        />
      )
    );
    expect(reveals(timing)).toBe(1);
  });

  it("does not animate a chart that mounts with its data", async () => {
    await motionAllowed(true);
    const timing = jest.spyOn(Reanimated, "withTiming");
    await renderWithProviders(<StreamArea {...fixture} loading={false} />);
    expect(reveals(timing)).toBe(0);
  });

  it("shows the data at once with Reduce Motion", async () => {
    await motionAllowed(false);
    const timing = jest.spyOn(Reanimated, "withTiming");
    const { rerender } = await renderWithProviders(
      <StreamArea {...fixture} loading />
    );
    await act(() => rerender(<StreamArea {...fixture} loading={false} />));
    expect(reveals(timing)).toBe(0);
  });
});
