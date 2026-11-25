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
  BATTERY_STAT_GRID,
  GPU_STAT_GRID,
  MEMORY_STACK,
  POPOVER_CPU_ROWS,
  POWER_STACK_BAR,
  POWER_STAT_GRID,
} from "@core/widget-models/fixtures/bars";
import {
  POPOVER_CPU_STREAM,
  POPOVER_GPU_STREAM,
} from "@core/widget-models/fixtures/charts";
import { inlineBarModel } from "@core/widget-models/inline-bar";
import { expect, it } from "vitest";
import {
  batteryCard,
  cpuCard,
  gpuCard,
  memoryCard,
  memoryFullLegend,
  networkCard,
  powerCard,
} from ".";

const empty = initialHostLive("host");

it("models CPU usage, inline bars and their chart announcement", () => {
  const cpu = { ...selectCpu(empty), total: 18, user: 12.4, system: 5.6 };
  const bars = POPOVER_CPU_ROWS.map(inlineBarModel).map((bar) => ({
    ...bar,
    track: { ...bar.track, fill: expect.closeTo(bar.track?.fill ?? 0) },
  }));
  expect(cpuCard(cpu, { chartLabel: POPOVER_CPU_STREAM.ariaLabel })).toEqual({
    title: "CPU",
    headline: "18%",
    segments: [],
    items: [],
    bars,
    spoken: "User 12.4%, System 5.6%, CPU, last 60 seconds, 18%",
  });

  const gap = cpuCard({ ...cpu, total: null, user: 0, system: null }, {});
  expect(gap.headline).toBe("—");
  expect(gap.bars.map((bar) => bar.track?.fill)).toEqual([0, null]);
  expect(gap.spoken).toBe("User 0.0%, System —");
  expect(cpuCard(cpu, { compact: true })).toMatchObject({
    headline: "18%",
    bars: [],
    spoken: "",
  });
});

it("models GPU frequency, power and measured renderer utilization", () => {
  const gpu = {
    ...selectGpu(empty),
    util: 36,
    render: 30,
    freqHz: 1.1e9,
    powerW: 3.1,
  };
  expect(gpuCard(gpu, { chartLabel: POPOVER_GPU_STREAM.ariaLabel })).toEqual({
    title: "GPU",
    headline: "36%",
    segments: [],
    items: [
      ...GPU_STAT_GRID.items.slice(0, 2),
      { label: "Render", value: "30%" },
    ],
    bars: [],
    spoken: "Freq 1.1 GHz, Power 3.1 W, Render 30%, GPU, last 60 seconds, 36%",
  });
  expect(gpuCard(selectGpu(empty), {}).spoken).toBe(
    "Freq —, Power —, Render —"
  );
});

it("models installed capacity, memory composition and pressure from the host", () => {
  const totalBytes = 24 * 2 ** 30;
  const scale = totalBytes / 24;
  const memory = {
    ...selectMemory(empty),
    composition: true,
    hasPressure: true,
    pressure: 65,
    pressureLevel: METRIC_CODES["mem.pressure_level"].warn,
    used: 17.6 * scale,
    wired: 3.9 * scale,
    app: 11.6 * scale,
    compressed: 2.1 * scale,
    cached: 4 * scale,
    free: 2.4 * scale,
    swapUsed: 512e6,
  };
  const card = memoryCard(memory, { totalBytes, bytes: "GiB" });
  expect(card).toMatchObject({
    title: "Memory",
    headline: "17.6",
    capacity: "/ 24 GB",
    usedUnit: "GiB",
    usedFraction: 17.6 / 24,
    pressureStatus: "warning",
    compactPressure: "Pressure · warn",
    items: MEMORY_STACK.extraLegend,
    bars: [
      inlineBarModel({
        label: "Pressure · warn",
        value: "65%",
        fraction: 0.65,
        layout: "wide",
      }),
    ],
    spoken:
      "Pressure · warn 65%, Wired 4.2 GB, App 12.5 GB, Compressed 2.3 GB, Cached files 4.3 GB, Free 2.6 GB, Swap 512 MB",
  });
  expect(card.segments).toEqual(
    MEMORY_STACK.segments.map((segment, index) => ({
      ...segment,
      value: ["4.2 GB", "12.5 GB", "2.3 GB", "4.3 GB", "2.6 GB"][index],
    }))
  );
  expect(memoryFullLegend(memory, totalBytes)).toEqual({
    segments: card.segments,
    pressure: card.bars[0],
    items: card.items,
  });
  expect(memoryCard(memory, { totalBytes, compact: true })).toMatchObject({
    usedFraction: 17.6 / 24,
    compactPressure: "Pressure · warn",
    segments: [],
    bars: [],
    items: [],
  });
});

it("models Linux memory with a used segment and missing capacity", () => {
  const memory = { ...selectMemory(empty), used: 4e9, cached: 2e9 };
  const card = memoryCard(memory, {});
  expect(card).toMatchObject({
    headline: "4.0",
    capacity: null,
    usedUnit: "GB",
    usedFraction: null,
    pressureStatus: null,
    bars: [],
    segments: [
      { key: "used", label: "Used", value: "4.0 GB", step: 1, fraction: null },
      {
        key: "cached",
        label: "Cached files",
        value: "2.0 GB",
        step: 4,
        fraction: null,
      },
      { key: "free", label: "Free", value: "—", step: "track", fraction: null },
    ],
    spoken: "Used 4.0 GB, Cached files 2.0 GB, Free —, Swap —",
  });
  expect(memoryCard(selectMemory(empty), {}).headline).toBe("—");
  const totalBytes = 8 * 2 ** 30;
  expect(
    memoryCard(memory, { totalBytes }).segments.map(({ fraction }) => fraction)
  ).toEqual([4e9 / totalBytes, 2e9 / totalBytes, null]);
});

it("keeps every row in the full memory legend when the host omits readings", () => {
  const totalBytes = 8 * 2 ** 30;
  const memory = { ...selectMemory(empty), used: 4e9, cached: 2e9 };
  expect(memoryFullLegend(memory, totalBytes)).toEqual({
    segments: MEMORY_STACK.segments.map((segment) => ({
      ...segment,
      value: segment.key === "cached" ? "2.0 GB" : "—",
      fraction: segment.key === "cached" ? 2e9 / totalBytes : null,
    })),
    pressure: inlineBarModel({
      label: "Pressure · normal",
      value: "—",
      fraction: null,
      layout: "wide",
    }),
    items: [{ label: "Swap", value: "—" }],
  });
});

it("reports a gap in a supported pressure series without a spoken level", () => {
  const memory = {
    ...selectMemory(empty),
    hasPressure: true,
    pressureLevel: METRIC_CODES["mem.pressure_level"].normal,
  };
  const card = memoryCard(memory, {});
  expect(card.bars[0]).toMatchObject({ value: "—", track: { fill: null } });
  expect(card.spoken).toBe(
    "Pressure —, Used —, Cached files —, Free —, Swap —"
  );
  const unknown = memoryCard({ ...memory, pressureLevel: null }, {});
  expect(unknown.bars[0]?.label).toBe("Pressure");
  expect(unknown.compactPressure).toBe("Pressure · normal");
});

it("models power rail swatches, the rest of system, and the combined card", () => {
  const power = {
    ...selectPower(empty),
    system: 14.8,
    cpu: 6.4,
    gpu: 3.1,
    ane: 0,
    dram: 0.9,
  };
  const battery = { ...selectBattery(empty), charge: 78, cycles: 122 };
  const card = powerCard(power, { battery, powerSource: "charging" });
  expect(card).toMatchObject({
    title: "Power & battery",
    headline: "14.8 W",
    unit: "system",
    headlineUnit: "system",
    note: null,
    items: POWER_STAT_GRID.items,
    bars: [],
    spoken:
      "CPU 6.4 W, GPU 3.1 W, ANE 0.0 W, DRAM 0.9 W, Battery 78%, To full On power, Health —, Cycles 122",
  });
  expect(card.segments.slice(0, 4)).toEqual(
    POWER_STACK_BAR.segments.slice(0, 4)
  );
  expect(card.segments[4]).toEqual({
    ...POWER_STACK_BAR.segments[4],
    fraction: expect.closeTo(4.4 / 14.8),
  });
  expect(card.battery).toEqual(
    batteryCard(battery, { powerSource: "charging" })
  );
  expect(powerCard(power, { showBattery: true })).toMatchObject({
    title: "Power & battery",
    hasBattery: true,
    battery: null,
  });
  const missing = powerCard(selectPower(empty), {});
  expect(missing).toMatchObject({
    title: "Power",
    headline: "—",
    headlineUnit: undefined,
    battery: null,
  });
  expect(missing.segments.map(({ fraction }) => fraction)).toEqual([
    null,
    null,
    null,
    null,
    null,
  ]);
});

it("models network rates, interface context, and a missing direction", () => {
  const network = { ...selectNetwork(empty), tx: 2.4e6 };
  expect(
    networkCard(network, {
      rate: "Mbps",
      primaryIface: "en0",
      chartLabel: "Network, last second",
    })
  ).toEqual({
    title: "Network",
    headline: "↑ 19.2 Mb/s · ↓ —",
    spokenHeadline: "Upload 19.2 Mb/s, Download —",
    subtitle: "All interfaces · en0",
    segments: [],
    items: [
      {
        label: "↑ Upload",
        value: "19.2",
        unit: "Mb/s",
        joinedValue: "19.2 Mb/s",
      },
      { label: "↓ Download", value: "—", joinedValue: "—" },
    ],
    bars: [],
    spoken: "All interfaces · en0, Network, last second",
  });
  expect(networkCard({ ...network, tx: 0 }, {}).headline).toBe("↑ 0 B/s · ↓ —");
});

it("treats non-finite network rates as missing in the headline and speech", () => {
  const network = { ...selectNetwork(empty), tx: Number.NaN, rx: Infinity };
  expect(networkCard(network, {})).toMatchObject({
    headline: "↑ — · ↓ —",
    spokenHeadline: "Upload —, Download —",
    items: [
      { label: "↑ Upload", value: "—", joinedValue: "—" },
      { label: "↓ Download", value: "—", joinedValue: "—" },
    ],
  });
});

it("models the battery meter, time to full, and unavailable time", () => {
  const battery = {
    ...selectBattery(empty),
    charge: 100,
    timeRemainingMin: 372,
    health: 94,
    cycles: 211.5,
  };
  expect(batteryCard(battery, { powerSource: "battery" })).toEqual({
    title: "Battery",
    headline: "100%",
    status: "On battery",
    chargeFraction: 1,
    remainingItems: BATTERY_STAT_GRID.items,
    segments: [],
    items: BATTERY_STAT_GRID.items,
    bars: [],
    spoken: "Remaining 6:12, Health 94%, Cycles 212",
  });
  const charging = batteryCard(
    { ...battery, timeRemainingMin: null },
    { powerSource: "charging" }
  );
  expect(charging.items[0]).toEqual({ label: "To full", value: "On power" });
  expect(charging.remainingItems[0]).toEqual({
    label: "Remaining",
    value: "On power",
  });
  expect(batteryCard(selectBattery(empty), {})).toMatchObject({
    headline: "—",
    status: "Power state unavailable",
    chargeFraction: null,
    spoken: "Remaining —, Health —, Cycles —",
  });
});
