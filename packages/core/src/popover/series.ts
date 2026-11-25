/**
 * The metrics the popover's cards read, shared by every app that draws the
 * popover card stack. The desktop popover adds its own footer metric on top.
 */
import type { SeriesSelector } from "@core/generated/types";

/**
 * Every metric the popover cards read, in card order, so a live channel can
 * carry only these (D-066 projection). A metric missing here reads as a gap
 * in a card, so the desktop popover route test renders every card against
 * this projection.
 */
export const POPOVER_CARD_METRICS = [
  // CPU card and cores card.
  "cpu.total",
  "cpu.user",
  "cpu.system",
  "cpu.load",
  "cpu.cluster.freq",
  // Memory card.
  "mem.used",
  "mem.app",
  "mem.wired",
  "mem.compressed",
  "mem.cached",
  "mem.free",
  "mem.pressure",
  "mem.pressure_level",
  "mem.swap_used",
  // GPU card.
  "gpu.util",
  "gpu.render",
  "gpu.tiler",
  "gpu.freq",
  // Power card, with the CPU power source label (D-065).
  "power.system",
  "power.cpu",
  "power.cpu_source",
  "power.gpu",
  "power.ane",
  "power.dram",
  "power.package",
  // Network card.
  "net.rx_total",
  "net.tx_total",
  "net.link_rate",
  // Battery card.
  "battery.charge",
  "battery.charging",
  "battery.external",
  "battery.time_remaining",
  "battery.health",
  "battery.cycles",
] as const;

/** {@link POPOVER_CARD_METRICS} as unlabelled series selectors. */
export const POPOVER_CARD_SERIES: readonly SeriesSelector[] =
  POPOVER_CARD_METRICS.map((metric) => ({ metric, labels: [] }));
