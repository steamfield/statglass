/**
 * Overview card props for a host without the macOS-only series a Linux agent
 * leaves out (D-116): no memory composition or pressure, no power split by
 * component, no per-process energy and no SoC hottest zone. Each starts from
 * the Mac card and replaces the parts that would otherwise read "—".
 */
import {
  formatBytes,
  formatPercent,
  formatRpm,
  formatTemperature,
  MISSING,
} from "@core/format";
import { topBy } from "@core/top-by";
import { type CardBase, memoryCard, powerCard } from "./card-props";

/**
 * Memory from `mem.used`, `mem.cached` and `mem.free` (used + cached + free
 * is MemTotal on Linux), with `mem.psi{stall=some}` for pressure stall.
 * The total is MemTotal as measured rather than a marketing size.
 */
export function usedMemoryCard(
  input: Omit<
    Parameters<typeof memoryCard>[0],
    "app" | "wired" | "compressed" | "pressureLevel"
  > & { cached: number | null; psiSome: number | null }
): CardBase {
  const units = input.binary ? "GiB" : "GB";
  const base = memoryCard({
    ...input,
    app: null,
    wired: null,
    compressed: null,
    pressureLevel: null,
  });
  return {
    ...base,
    stats: [
      { label: "Used", value: base.value },
      {
        label: "Cached",
        value: formatBytes(input.cached, { units, decimals: 1 }),
      },
      {
        label: "Pressure stall",
        value: formatPercent(input.psiSome, { decimals: 1 }),
      },
      { label: "Swap", value: formatBytes(input.swapUsed, { units }) },
    ],
  };
}

/**
 * Power from `power.system` and the `thermal.sensor` readings: system draw
 * alone, the hottest sensor as a fact, and sensors hottest first in place
 * of top processes by energy (D-116).
 */
export function sensorPowerCard(
  input: Omit<
    Parameters<typeof powerCard>[0],
    "cpu" | "gpu" | "dram" | "hottestC" | "processes"
  > & { sensors: readonly { name: string; c: number | null }[] }
): CardBase {
  const hottest = topBy(input.sensors, (s) => s.c, 5);
  const base = powerCard({
    ...input,
    cpu: null,
    gpu: null,
    dram: null,
    hottestC: hottest[0]?.value ?? null,
    processes: [],
  });
  return {
    ...base,
    stats: [
      {
        label: "Hottest sensor",
        value: hottest[0]
          ? formatTemperature(hottest[0].value, { units: input.temperature })
          : MISSING,
      },
      {
        label: "Fans",
        value: input.passive ? "Passive cooling" : formatRpm(input.fanRpm),
      },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Temperature sensors, hottest first",
      rows: hottest.map(({ row: s, value: c }) => ({
        id: s.name,
        initial: s.name.slice(0, 1),
        name: s.name,
        value: formatTemperature(c, { units: input.temperature }),
      })),
    },
  };
}
