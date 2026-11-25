import type { SeriesSelector } from "@core/generated/types";
import { POPOVER_CARD_METRICS } from "@core/popover/series";

/**
 * What the module pages read live beyond the popover cards. The phone keeps
 * one live session per host for the host screen and its module pages, so the
 * session carries both; an unlabelled selector matches every label set.
 */
const MODULE_PAGE_METRICS = [
  // CPU page: stat strip and cluster rows.
  "cpu.iowait",
  "cpu.steal",
  "cpu.loadavg",
  "cpu.psi",
  "cpu.cluster.active",
  "cpu.cluster.residency",
  "cpu.cluster.power",
  // GPU page: residency stack.
  "gpu.residency",
  // Memory page: pressure stall and the swap card.
  "mem.psi",
  "mem.swap_in",
  "mem.swap_out",
  // Network page: interfaces list.
  "net.rx",
  "net.tx",
  // Power & Sensors page: named rails where the host has no CPU split, rings
  // and thermal zones.
  "power.sensor",
  "thermal.cpu",
  "thermal.gpu",
  "thermal.hottest",
  "thermal.zone",
  "thermal.sensor",
  "fan.rpm",
  "fan.max",
  "fan.mode",
  // Battery page.
  "battery.power",
  "battery.temp",
  "battery.capacity_wh",
  "battery.design_wh",
] as const;

/** The phone's live projection (D-066): the popover cards plus the module pages. */
export const PHONE_LIVE_SERIES: readonly SeriesSelector[] = [
  ...POPOVER_CARD_METRICS,
  ...MODULE_PAGE_METRICS,
].map((metric) => ({ metric, labels: [] }));
