/**
 * Overview-only selectors over a host's live state. Each returns a primitive
 * or a flat record of primitives, so `useShallow` keeps a frame that did not
 * move them from re-rendering the card.
 */
import type { HostLive } from "@core/live-state";
import { parseLabels, sk } from "@core/series-key";
import { held, keysOf } from "~/stores/live-selectors";

/** `{ "rx|en0": 38.4e6, "tx|en0": 1.2e6, … }` for every interface. */
export function ifaceRates(s: HostLive): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const metric of ["net.rx", "net.tx"] as const) {
    for (const k of keysOf(s, metric)) {
      const iface = parseLabels(k).iface;
      if (iface !== undefined) out[`${metric.slice(4)}|${iface}`] = held(s, k);
    }
  }
  return out;
}

/** `net.link_rate` of `iface`, bits/s. */
export function linkRate(s: HostLive, iface: string | null): number | null {
  if (iface === null) return null;
  return held(s, sk("net.link_rate", { iface }));
}

/** `{ "NAND Flash Temperature": 40, … }`: every `thermal.sensor{name}`. */
export function thermalSensors(s: HostLive): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of keysOf(s, "thermal.sensor")) {
    const name = parseLabels(k).name;
    if (name !== undefined) out[name] = held(s, k);
  }
  return out;
}
