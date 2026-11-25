import { expect, jest, test } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import * as Battery from "expo-battery";
import { AccessibilityInfo, DeviceEventEmitter } from "react-native";
import { motionDurations, motionEasings } from "@/theme.generated";
import { MotionProvider, useMotion } from "@/ui/motion";

const zeroDurations = Object.fromEntries(
  Object.keys(motionDurations).map((name) => [name, 0])
);

function mockSignals(reduceMotion: boolean, lowPowerMode: boolean) {
  const readMotion = jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockClear()
    .mockResolvedValue(reduceMotion);
  const readPower = jest
    .spyOn(Battery, "isLowPowerModeEnabledAsync")
    .mockResolvedValue(lowPowerMode);
  const motion = jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockClear()
    .mockImplementation((event, listener) =>
      DeviceEventEmitter.addListener(event, listener)
    );
  const power = jest.spyOn(Battery, "addLowPowerModeListener");
  return { motion, power, readMotion, readPower };
}

test.each([
  { reduceMotion: true, lowPowerMode: false, reduced: true },
  { reduceMotion: false, lowPowerMode: true, reduced: true },
  { reduceMotion: false, lowPowerMode: false, reduced: false },
])(
  "Reduce Motion $reduceMotion and Low Power Mode $lowPowerMode yield reduced $reduced",
  async ({ reduceMotion, lowPowerMode, reduced }) => {
    mockSignals(reduceMotion, lowPowerMode);
    const { result } = await renderHook(useMotion, { wrapper: MotionProvider });
    expect(result.current).toEqual({
      ...(reduced ? zeroDurations : motionDurations),
      ...motionEasings,
      reduced,
    });
  }
);

test("starts still and trusts a change event over a pending initial read", async () => {
  const { readPower } = mockSignals(false, false);
  const pending = Promise.withResolvers<boolean>();
  readPower.mockReturnValue(pending.promise);
  const readTokens = jest.fn(useMotion);
  const { result } = await renderHook(readTokens, { wrapper: MotionProvider });
  expect(readTokens.mock.results[0]?.value).toMatchObject({
    ...zeroDurations,
    reduced: true,
  });
  expect(result.current).toMatchObject({ ...zeroDurations, reduced: true });

  await act(() =>
    DeviceEventEmitter.emit("mockLowPowerModeChanged", { lowPowerMode: false })
  );
  expect(result.current.reduced).toBe(false);
  await act(() => pending.resolve(true));
  expect(result.current.reduced).toBe(false);
});

test("subscribes once to each signal and only renders consumers when motion changes", async () => {
  const { motion, power, readMotion, readPower } = mockSignals(false, false);
  const priorMotionListeners = DeviceEventEmitter.listenerCount(
    "reduceMotionChanged"
  );
  const priorPowerListeners = DeviceEventEmitter.listenerCount(
    "mockLowPowerModeChanged"
  );
  const tracker = jest.fn(useMotion);
  const { unmount, result } = await renderHook(tracker, {
    wrapper: MotionProvider,
  });
  expect(readMotion).toHaveBeenCalledTimes(1);
  expect(readPower).toHaveBeenCalledTimes(1);
  expect(motion).toHaveBeenCalledTimes(1);
  expect(power).toHaveBeenCalledTimes(1);
  expect(DeviceEventEmitter.listenerCount("reduceMotionChanged")).toBe(
    priorMotionListeners + 1
  );
  expect(DeviceEventEmitter.listenerCount("mockLowPowerModeChanged")).toBe(
    priorPowerListeners + 1
  );

  tracker.mockClear();
  await act(() => DeviceEventEmitter.emit("reduceMotionChanged", true));
  expect(result.current.reduced).toBe(true);
  expect(tracker).toHaveBeenCalledTimes(1);
  await act(() => DeviceEventEmitter.emit("reduceMotionChanged", true));
  await act(() =>
    DeviceEventEmitter.emit("mockLowPowerModeChanged", { lowPowerMode: true })
  );
  await act(() => DeviceEventEmitter.emit("reduceMotionChanged", false));
  expect(tracker).toHaveBeenCalledTimes(1);
  await act(() =>
    DeviceEventEmitter.emit("mockLowPowerModeChanged", { lowPowerMode: false })
  );
  expect(result.current.reduced).toBe(false);
  expect(tracker).toHaveBeenCalledTimes(2);

  await unmount();
  expect(DeviceEventEmitter.listenerCount("reduceMotionChanged")).toBe(
    priorMotionListeners
  );
  expect(DeviceEventEmitter.listenerCount("mockLowPowerModeChanged")).toBe(
    priorPowerListeners
  );
});

test.each(["Reduce Motion", "Low Power Mode"])(
  "a failed %s read logs once and keeps motion off",
  async (name) => {
    const { readMotion, readPower } = mockSignals(false, false);
    const error = new Error("Preference unavailable");
    const read = name === "Reduce Motion" ? readMotion : readPower;
    read.mockRejectedValue(error);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result, rerender } = await renderHook(useMotion, {
      wrapper: MotionProvider,
    });
    await rerender(undefined);
    expect(result.current).toMatchObject({ ...zeroDurations, reduced: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`Could not read ${name}`, error);
  }
);

test("useMotion requires a MotionProvider", async () => {
  await expect(renderHook(useMotion)).rejects.toThrow("outside MotionProvider");
});
