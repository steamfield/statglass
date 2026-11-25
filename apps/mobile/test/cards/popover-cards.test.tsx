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
import { fireEvent, screen, userEvent } from "@testing-library/react-native";
import { BatteryCard } from "@/cards/battery-card";
import { CpuCard } from "@/cards/cpu-card";
import { GpuCard } from "@/cards/gpu-card";
import { MemoryCard } from "@/cards/memory-card";
import { NetworkCard } from "@/cards/network-card";
import { PowerCard } from "@/cards/power-card";
import { UnavailableCard } from "@/cards/unavailable-card";

const empty = initialHostLive("host");
const chrome = {
  compact: false,
  onOpen: () => {},
  onToggleDensity: () => {},
  stale: false,
};

test("CPU opens from the body and has a separate 44 pt density control", async () => {
  const onOpen = jest.fn();
  const onToggleDensity = jest.fn();
  const cpu = { ...selectCpu(empty), total: 18, user: 12.4 };
  const { rerender } = await renderWithProviders(
    <CpuCard
      {...chrome}
      cpu={cpu}
      stream={{ ...POPOVER_CPU_STREAM, height: 64 }}
      onOpen={onOpen}
      onToggleDensity={onToggleDensity}
    />
  );
  const button = () => screen.getByRole("button", { name: "CPU, 18%" });
  const density = () =>
    screen.getByRole("button", { name: "Compact CPU card" });
  expect(density()).toHaveStyle({ height: 44, width: 44 });
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(button()).toHaveAccessibilityValue({
    text: "User 12.4%, System —, CPU, last 60 seconds, 18%",
  });
  expect(screen.getByText("18%")).toHaveStyle({
    fontVariant: ["tabular-nums"],
  });
  expect(screen.getByText("User")).toBeOnTheScreen();
  expect(screen.getByText("12.4%")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: POPOVER_CPU_STREAM.ariaLabel })
  ).toHaveStyle({ height: 52 });
  expect(screen.getByText("40%")).toBeOnTheScreen();
  const user = userEvent.setup();
  await user.press(button());
  expect(onOpen).toHaveBeenCalledTimes(1);
  await user.press(density());
  expect(onToggleDensity).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledTimes(1);

  await rerender(
    <CpuCard {...chrome} compact cpu={cpu} stream={POPOVER_CPU_STREAM} />
  );
  expect(
    screen.getByRole("button", { name: "Expand CPU card" })
  ).toBeOnTheScreen();
  expect(screen.queryByText("User")).toBeNull();
  expect(
    screen.getByRole("image", { name: POPOVER_CPU_STREAM.ariaLabel })
  ).toHaveStyle({ height: 14 });
  expect(screen.queryByText("40%")).toBeNull();
});

test("stack actions make the card one VoiceOver element", async () => {
  const onOpen = jest.fn();
  const onAccessibilityAction = jest.fn();
  const actions = [
    { name: "toggleCompact", label: "Toggle compact" },
    { name: "open", label: "Open" },
    { name: "moveUp", label: "Move up" },
    { name: "moveDown", label: "Move down" },
    { name: "moveToTop", label: "Move to top" },
  ];
  await renderWithProviders(
    <CpuCard
      {...chrome}
      cpu={{ ...selectCpu(empty), total: 18 }}
      stream={POPOVER_CPU_STREAM}
      onOpen={onOpen}
      accessibilityActions={actions}
      onAccessibilityAction={onAccessibilityAction}
    />
  );
  const card = () => screen.getByRole("button", { name: "CPU, 18%" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Compact CPU card" })).toBeNull();
  expect(screen.queryByRole("image")).toBeNull();
  expect(card()).toHaveAccessibilityValue({
    text: "User —, System —, CPU, last 60 seconds, 18%",
  });
  const event = { nativeEvent: { actionName: "moveUp" } };
  await fireEvent(card(), "accessibilityAction", event);
  expect(onAccessibilityAction).toHaveBeenCalledWith(event);
  await fireEvent(card(), "accessibilityTap");
  expect(onOpen).toHaveBeenCalledTimes(1);
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
  const { rerender } = await renderWithProviders(
    <MemoryCard {...chrome} memory={memory} totalBytes={16 * 2 ** 30} />
  );
  expect(
    screen.getByRole("button", { name: "Memory, 8.0 / 16 GB" })
  ).toHaveAccessibilityValue({
    text: "Pressure · warn 65%, Wired 2.0 GB, App 6.0 GB, Compressed 0 B, Cached files 4.0 GB, Free 4.0 GB, Swap —",
  });
  expect(screen.getByText("Pressure · warn")).toBeOnTheScreen();
  expect(screen.getByTestId("status-warning")).toBeOnTheScreen();
  expect(screen.queryByTestId("status-critical")).toBeNull();
  expect(screen.getByText("65%")).toBeOnTheScreen();
  expect(screen.getByText("Compressed")).toBeOnTheScreen();
  expect(screen.getByText("0 B")).toBeOnTheScreen();
  expect(screen.getByText("Swap")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();

  const levels = METRIC_CODES["mem.pressure_level"];
  await rerender(
    <MemoryCard
      {...chrome}
      memory={{ ...memory, pressureLevel: levels.critical }}
      totalBytes={16 * 2 ** 30}
    />
  );
  expect(screen.getByTestId("status-critical")).toBeOnTheScreen();
  expect(screen.queryByTestId("status-warning")).toBeNull();

  await rerender(
    <MemoryCard
      {...chrome}
      memory={{ ...memory, pressureLevel: levels.normal }}
      totalBytes={16 * 2 ** 30}
    />
  );
  expect(screen.getByText("Pressure · normal")).toBeOnTheScreen();
  expect(screen.queryByTestId(/^status-/)).toBeNull();

  await rerender(
    <MemoryCard
      {...chrome}
      compact
      memory={{ ...memory, pressureLevel: levels.normal }}
      totalBytes={16 * 2 ** 30}
    />
  );
  expect(screen.getByText("Pressure · normal")).toBeOnTheScreen();
  expect(screen.queryByText("Swap")).toBeNull();
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

test("VoiceOver includes a critical pressure level even without a percentage", async () => {
  const memory = {
    ...selectMemory(empty),
    hasPressure: true,
    pressureLevel: METRIC_CODES["mem.pressure_level"].critical,
  };
  await renderWithProviders(
    <MemoryCard {...chrome} memory={memory} totalBytes={null} />
  );
  expect(
    screen.getByRole("button", { name: `Memory, ${MISSING}` })
  ).toHaveAccessibilityValue({
    text: "Pressure · critical —, Used —, Cached files —, Free —, Swap —",
  });
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
  expect(
    screen.getByRole("image", {
      name: "Used 4.0 GB, Cached files 2.0 GB, Free —",
    })
  ).toBeOnTheScreen();
  expect(screen.getByTestId("empty-stack")).toBeOnTheScreen();
  expect(screen.queryAllByTestId("stack-segment")).toHaveLength(0);
  await rerender(
    <MemoryCard {...chrome} memory={memory} totalBytes={8 * 2 ** 30} />
  );
  expect(
    screen.getByRole("button", { name: "Memory, 4.0 / 8 GB" })
  ).toBeOnTheScreen();
  expect(screen.getAllByTestId("stack-segment")).toHaveLength(2);
  expect(screen.queryByTestId("empty-stack")).toBeNull();
});

test("GPU announces its chart and identifies its render utilization", async () => {
  const gpu = { ...selectGpu(empty), util: 36, render: 30, freqHz: 1.1e9 };
  const { rerender } = await renderWithProviders(
    <GpuCard {...chrome} gpu={gpu} stream={POPOVER_GPU_STREAM} />
  );
  expect(
    screen.getByRole("button", { name: "GPU, 36%" })
  ).toHaveAccessibilityValue({
    text: "Freq 1.1 GHz, Power —, Render 30%, GPU, last 60 seconds, 36%",
  });
  expect(
    screen.getByRole("image", { name: POPOVER_GPU_STREAM.ariaLabel })
  ).toBeOnTheScreen();
  expect(screen.getByText("1.1 GHz")).toBeOnTheScreen();
  expect(screen.getByText("Render")).toBeOnTheScreen();
  expect(screen.getByText("30%")).toBeOnTheScreen();
  expect(screen.getByText(MISSING)).toBeOnTheScreen();
  await rerender(
    <GpuCard {...chrome} compact gpu={gpu} stream={POPOVER_GPU_STREAM} />
  );
  expect(
    screen.getByRole("image", { name: POPOVER_GPU_STREAM.ariaLabel })
  ).toHaveStyle({ height: 14 });
  expect(screen.queryByText("Render")).toBeNull();
});

test("power shows system watts and measured zero rails and omits unreported rails", async () => {
  const power = {
    ...selectPower(empty),
    system: 14.8,
    cpu: 6.4,
    gpu: 3.1,
    ane: 0,
  };
  const { rerender } = await renderWithProviders(
    <PowerCard {...chrome} power={power} source="battery" battery={null} />
  );
  expect(
    screen.getByRole("button", { name: "Power, 14.8 W system" })
  ).toHaveAccessibilityValue({
    text: "CPU 6.4 W, GPU 3.1 W, ANE 0.0 W",
  });
  expect(screen.getByText("ANE")).toBeOnTheScreen();
  expect(screen.getByText("0.0 W")).toBeOnTheScreen();
  expect(screen.queryByText("DRAM")).toBeNull();
  expect(screen.queryByText(MISSING)).toBeNull();
  expect(screen.queryByRole("image")).toBeNull();
  await rerender(
    <PowerCard
      {...chrome}
      power={{ ...power, dram: 1 }}
      source="battery"
      battery={null}
    />
  );
  expect(
    screen.getByRole("image", {
      name: "CPU 6.4 W, GPU 3.1 W, ANE 0.0 W, DRAM 1.0 W, Rest of system 4.3 W",
    })
  ).toBeOnTheScreen();
});

test("power without any readings stays as one row that can still open its module", async () => {
  const onOpen = jest.fn();
  await renderWithProviders(
    <PowerCard
      {...chrome}
      power={selectPower(empty)}
      source={null}
      battery={selectBattery(empty)}
      onOpen={onOpen}
    />
  );
  const row = screen.getByRole("button", { name: "Power, No power readings" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("image")).toBeNull();
  expect(screen.queryByText(MISSING)).toBeNull();
  await userEvent.setup().press(row);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("a package-only power reading is labelled as package watts", async () => {
  await renderWithProviders(
    <PowerCard
      {...chrome}
      power={{ ...selectPower(empty), package: 9.4 }}
      battery={null}
      source={null}
    />
  );
  expect(
    screen.getByRole("button", { name: "Power, 9.4 W package" })
  ).toBeOnTheScreen();
  expect(screen.queryByText("system")).toBeNull();
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
  expect(screen.getByRole("button", { name })).toHaveAccessibilityValue({
    text: "Battery 78%, To full On power, Health 94%, Cycles 122",
  });
  expect(screen.getByText("Battery")).toBeOnTheScreen();
  expect(screen.getByText("78%")).toBeOnTheScreen();
  expect(screen.getByText("To full")).toBeOnTheScreen();
  expect(screen.getByText("On power")).toBeOnTheScreen();
  expect(screen.getByText("94%")).toBeOnTheScreen();
  expect(screen.getByText("122")).toBeOnTheScreen();

  await rerender(<PowerCard {...card} compact />);
  expect(
    screen.getByRole("button", { name: `${name}, Battery 78%` })
  ).toBeOnTheScreen();
  expect(screen.getByText("14.8 W system · 78%")).toBeOnTheScreen();
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
  ).toHaveAccessibilityValue({ text: "All interfaces, Network, last second" });
  expect(screen.getByText("All interfaces")).toBeOnTheScreen();
  expect(
    screen.getByText("↑ Upload", { includeHiddenElements: true })
  ).toBeOnTheScreen();
  expect(
    screen.getByText("↓ Download", { includeHiddenElements: true })
  ).toBeOnTheScreen();
  expect(
    screen.getByText(`↑\u00a02.4\u00a0MB/s · ↓\u00a0${MISSING}`, {
      normalizer: (text) => text,
    })
  ).toBeOnTheScreen();
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
  expect(screen.getByRole("image", { name: bars.ariaLabel })).toBeOnTheScreen();
});

test("Network keeps both direction names visible before plot data arrives", async () => {
  await renderWithProviders(
    <NetworkCard {...chrome} network={selectNetwork(empty)} bars={null} />
  );
  expect(
    screen.getByText("↑ Upload", { includeHiddenElements: true })
  ).toBeOnTheScreen();
  expect(
    screen.getByText("↓ Download", { includeHiddenElements: true })
  ).toBeOnTheScreen();
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
    screen.getByRole("button", { name: "Battery, 78%" })
  ).toHaveAccessibilityValue({
    text: "Remaining 1:45, Health —, Cycles 123",
  });
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
    expect(screen.getByLabelText(`GPU, ${text}`)).toBeOnTheScreen();
    expect(screen.queryByRole("button")).toBeNull();
  }
);
