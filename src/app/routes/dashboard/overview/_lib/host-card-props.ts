/** Facts for hosts without macOS memory composition or component power. */
import { formatBytes, formatPercent, formatTemperature } from "@core/format";
import { topBy } from "@core/top-by";
import { type CardBase, memoryCard, powerCard } from "./card-props";

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
      { label: "Hottest sensor", value: base.stats[0]?.value ?? "—" },
      ...base.stats.slice(1, 2),
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
