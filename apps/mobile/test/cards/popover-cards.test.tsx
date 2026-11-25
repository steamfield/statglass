import { MISSING } from "@core/format";
import { METRIC_CODES } from "@core/generated/types";
import {
  selectBattery,
  selectCpu,
  selectGpu,
  selectMemory,
  selectNetwork,
  selectPower,
} from "@core/live-selectors";
import { initialHostLive } from "@core/live-state";
import {
  POPOVER_CPU_STREAM,
  POPOVER_GPU_STREAM,
} from "@core/widget-models/fixtures/charts";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import {
  fireEvent,
  screen,
  userEvent,
  within,
} from "@testing-library/react-native";
import { BatteryCard } from "@/cards/battery-card";
import { CpuCard } from "@/cards/cpu-card";
import { GpuCard } from "@/cards/gpu-card";
import { MemoryCard } from "@/cards/memory-card";
import { NetworkCard } from "@/cards/network-card";
import { PowerCard } from "@/cards/power-card";
import { UnavailableCard } from "@/cards/unavailable-card";
import * as streamArea from "@/widgets/stream-area";

const empty = initialHostLive("host");
const chrome = { compact: false, onOpen: () => {}, onLongPress: () => {} };

test("CPU passes its stream through and opens the page or card menu", async () => {
  const stream = jest.spyOn(streamArea, "StreamArea");
  const onOpen = jest.fn();
  const onLongPress = jest.fn();
  const cpu = { ...selectCpu(empty), total: 18, user: 12.4 };
  const { rerender } = await renderWithProviders(
    <CpuCard
      {...chrome}
      cpu={cpu}
      stream={POPOVER_CPU_STREAM}
      onOpen={onOpen}
      onLongPress={onLongPress}
    />
  );
  const button = screen.getByRole("button", { name: "CPU, 18%" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(button).toHaveAccessibilityValue({
    text: "User 12.4%, System —, CPU, last 60 seconds, 18%",
  });
  expect(screen.getByText("18%")).toHaveStyle({
    fontVariant: ["tabular-nums"],
  });
  expect(screen.getByText("User")).toBeOnTheScreen();
  expect(screen.getByText("12.4%")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
  expect(stream.mock.calls.at(-1)?.[0]).toEqual(POPOVER_CPU_STREAM);
  const user = userEvent.setup();
  await user.press(button);
  expect(onOpen).toHaveBeenCalledTimes(1);
  await user.longPress(button);
  expect(onLongPress).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledTimes(1);
  await fireEvent(button, "accessibilityAction", {
    nativeEvent: { actionName: "menu" },
  });
  expect(onLongPress).toHaveBeenCalledTimes(2);

  stream.mockClear();
  await rerender(
    <CpuCard {...chrome} compact cpu={cpu} stream={POPOVER_CPU_STREAM} />
  );
  expect(
    screen.getByRole("button", { name: "CPU, 18%" })
  ).toHaveAccessibilityValue({});
  expect(screen.queryByText("User")).toBeNull();
  expect(stream).not.toHaveBeenCalled();
});

test("memory shows pressure, composition and missing swap below its headline", async () => {
  const memory = {
    ...selectMemory(empty),
    used: 8e9,
    wired: 2e9,
    app: 6e9,
    compressed: 0,
    cached: 4e9,
    free: 4e9,
    pressure: 65,
    pressureLevel: METRIC_CODES["mem.pressure_level"].warn,
    composition: true,
    hasPressure: true,
  };
  await renderWithProviders(
    <MemoryCard {...chrome} memory={memory} totalBytes={16 * 2 ** 30} />
  );
  expect(
    screen.getByRole("button", { name: "Memory, 8.0 / 16 GB" })
  ).toBeOnTheScreen();
  expect(screen.getByText("Pressure · warn")).toBeOnTheScreen();
  expect(screen.getByTestId("status-warning")).toBeOnTheScreen();
  expect(screen.getByText("65%")).toBeOnTheScreen();
  expect(screen.getByText("Compressed")).toBeOnTheScreen();
  expect(screen.getByText("0 B")).toBeOnTheScreen();
  expect(screen.getByText("Swap")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
});

test("without readings, memory keeps the physical measurements missing", async () => {
  await renderWithProviders(
    <MemoryCard {...chrome} memory={selectMemory(empty)} totalBytes={null} />
  );
  expect(
    screen.getByRole("button", { name: `Memory, ${MISSING}` })
  ).toBeOnTheScreen();
  expect(screen.queryByText("Pressure · normal")).toBeNull();
  expect(screen.queryByText("0 B")).toBeNull();
  expect(screen.getByText("Swap")).toBeOnTheScreen();
});

test("Linux memory shows measured Used and omits capacity when a part is missing", async () => {
  const memory = {
    ...selectMemory(empty),
    used: 4e9,
    cached: 2e9,
  };
  const { rerender } = await renderWithProviders(
    <MemoryCard {...chrome} memory={memory} totalBytes={null} />
  );
  expect(
    screen.getByRole("button", { name: "Memory, 4.0 GB" })
  ).toBeOnTheScreen();
  expect(screen.getByText("Used")).toBeOnTheScreen();
  expect(screen.getByText("Cached files")).toBeOnTheScreen();
  expect(screen.queryByText("App")).toBeNull();
  expect(screen.queryByText("Pressure")).toBeNull();
  expect(screen.getByTestId("empty-stack")).toBeOnTheScreen();
  await rerender(
    <MemoryCard {...chrome} memory={memory} totalBytes={8 * 2 ** 30} />
  );
  expect(
    screen.getByRole("button", { name: "Memory, 4.0 / 8 GB" })
  ).toBeOnTheScreen();
  expect(screen.getAllByTestId("stack-segment")).toHaveLength(2);
  expect(screen.queryByTestId("empty-stack")).toBeNull();
});

test("GPU passes its stream through and identifies its render utilization", async () => {
  const stream = jest.spyOn(streamArea, "StreamArea");
  const gpu = { ...selectGpu(empty), util: 36, render: 30, freqHz: 1.1e9 };
  await renderWithProviders(
    <GpuCard {...chrome} gpu={gpu} stream={POPOVER_GPU_STREAM} />
  );
  expect(screen.getByRole("button", { name: "GPU, 36%" })).toBeOnTheScreen();
  expect(stream.mock.calls.at(-1)?.[0]).toEqual(POPOVER_GPU_STREAM);
  expect(screen.getByText("1.1 GHz")).toBeOnTheScreen();
  expect(screen.getByText("Render")).toBeOnTheScreen();
  expect(screen.getByText("30%")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
});

test("power shows system watts, measured zero rails and missing rails", async () => {
  const power = {
    ...selectPower(empty),
    system: 14.8,
    cpu: 6.4,
    gpu: 3.1,
    ane: 0,
  };
  await renderWithProviders(
    <PowerCard {...chrome} power={power} source="battery" battery={null} />
  );
  expect(
    screen.getByRole("button", { name: "Power, 14.8 W system" })
  ).toBeOnTheScreen();
  expect(screen.getByText("ANE")).toBeOnTheScreen();
  expect(screen.getByText("0.0 W")).toBeOnTheScreen();
  expect(screen.getByText("DRAM")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
});

test("power includes the battery readings when the combined card occupies both slots", async () => {
  const power = { ...selectPower(empty), system: 14.8 };
  const battery = {
    ...selectBattery(empty),
    charge: 78,
    health: 94,
    cycles: 122,
  };
  const card = { ...chrome, power, battery, source: "charging" } as const;
  const { rerender } = await renderWithProviders(<PowerCard {...card} />);
  const name = "Power & battery, 14.8 W system";
  expect(
    within(screen.getByRole("button", { name })).getByTestId("meter-track", {
      includeHiddenElements: true,
    })
  ).toHaveProp("className", expect.stringContaining("h-1.5"));
  expect(screen.getByText("Battery")).toBeOnTheScreen();
  expect(screen.getByText("78%")).toBeOnTheScreen();
  expect(screen.getByText("To full")).toBeOnTheScreen();
  expect(screen.getByText("On power")).toBeOnTheScreen();
  expect(screen.getByText("94%")).toBeOnTheScreen();
  expect(screen.getByText("122")).toBeOnTheScreen();

  await rerender(<PowerCard {...card} compact />);
  expect(screen.getByRole("button", { name })).toBeOnTheScreen();
  expect(screen.queryByText("78%")).toBeNull();
  expect(screen.queryByText("To full")).toBeNull();
});

test("network names both directions in its headline and keeps a missing rate visible", async () => {
  const network = { ...selectNetwork(empty), tx: 2_400_000 };
  const bars = {
    up: [2_400_000],
    down: [null],
    upMax: 3_000_000,
    downMax: 100_000,
    intervalMs: 1000,
    accent: "net",
    ariaLabel: "Network, last second",
  } as const;
  const { rerender } = await renderWithProviders(
    <NetworkCard {...chrome} network={network} bars={bars} />
  );
  expect(
    screen.getByRole("button", {
      name: `Network, Upload 2.4 MB/s, Download ${MISSING}`,
    })
  ).toBeOnTheScreen();
  expect(screen.getByText("All interfaces")).toBeOnTheScreen();
  expect(screen.getByText("↑ Upload")).toBeOnTheScreen();
  expect(screen.getByText("↓ Download")).toBeOnTheScreen();
  expect(screen.getByText("2.4 MB/s")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
  expect(screen.getByRole("image", { name: bars.ariaLabel })).toBeOnTheScreen();
  await rerender(
    <NetworkCard {...chrome} compact network={network} bars={bars} />
  );
  expect(
    screen.getByText(`↑\u00a02.4\u00a0MB/s · ↓\u00a0${MISSING}`, {
      normalizer: (text) => text,
    })
  ).toBeOnTheScreen();
  expect(screen.queryByText("All interfaces")).toBeNull();
  expect(screen.queryByRole("image")).toBeNull();
});

test("battery shows charge, remaining time, health and rounded cycles", async () => {
  const battery = {
    ...selectBattery(empty),
    charge: 78,
    timeRemainingMin: 105,
    cycles: 122.5,
  };
  await renderWithProviders(
    <BatteryCard {...chrome} battery={battery} source="battery" />
  );
  expect(
    within(screen.getByRole("button", { name: "Battery, 78%" })).getByTestId(
      "meter-track",
      { includeHiddenElements: true }
    )
  ).toHaveProp("className", expect.stringContaining("h-1.5"));
  expect(screen.getByText("Remaining")).toBeOnTheScreen();
  expect(screen.getByText("1:45")).toBeOnTheScreen();
  expect(screen.getByText("Health")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
  expect(screen.getByText("123")).toBeOnTheScreen();
});

test("battery uses the host source for charging and leaves unknown time missing", async () => {
  const battery = { ...selectBattery(empty), charge: 78, external: 1 };
  const { rerender } = await renderWithProviders(
    <BatteryCard {...chrome} battery={battery} source={null} />
  );
  expect(screen.getByText("Remaining")).toBeOnTheScreen();
  expect(screen.queryByText("On power")).toBeNull();
  await rerender(
    <BatteryCard
      {...chrome}
      battery={{ ...battery, timeRemainingMin: 105 }}
      source="charging"
    />
  );
  expect(screen.getByText("To full")).toBeOnTheScreen();
  expect(screen.getByText("1:45")).toBeOnTheScreen();
});

test.each([
  ["edition", "Not available in this edition"],
  ["unavailable", "Not available on this host"],
] as const)(
  "describes the %s state without presenting a button",
  async (state, text) => {
    await renderWithProviders(<UnavailableCard module="gpu" state={state} />);
    expect(screen.getByText("GPU")).toBeOnTheScreen();
    expect(screen.getByText(text)).toBeOnTheScreen();
    expect(screen.getByTestId("status-info")).toBeOnTheScreen();
    expect(screen.queryByRole("button")).toBeNull();
  }
);
