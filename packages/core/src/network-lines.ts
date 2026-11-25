import { formatRate, MISSING } from "@core/format";
import { keyByLabel } from "@core/series-key";

export interface InterfaceRow {
  /** BSD name and row key, "en0". */
  id: string;
  /** "Wi‑Fi", "Ethernet", "VPN", "Bridge". */
  kind: string;
  /** `net.rx{iface}` / `net.tx{iface}`, bytes per second; `null` is a gap. */
  rxBps: number | null;
  txBps: number | null;
  /** Received and sent since boot, bytes. */
  rxBytes: number | null;
  txBytes: number | null;
  /** The interface left the layout (cable pulled, VPN down). */
  disconnected?: boolean;
}

/**
 * One row per interface in the layout, in layout order so rows do not jump.
 * Kind and since-boot totals are not in the schema yet (D-045 keeps them as
 * collector methods), so they render as missing rather than guessed from the
 * BSD name.
 */
const rxKey = keyByLabel("net.rx", "iface");
const txKey = keyByLabel("net.tx", "iface");

export function interfaceRows(
  ifaces: readonly string[],
  held: Record<string, number | null>
): InterfaceRow[] {
  return ifaces.map((id) => ({
    id,
    kind: MISSING,
    rxBps: held[rxKey(id)] ?? null,
    txBps: held[txKey(id)] ?? null,
    rxBytes: null,
    txBytes: null,
  }));
}

/** Download as a share of the link, percent; null without both figures. */
export function ofLink(
  rxBps: number | null,
  linkBitsPerSec: number | null
): number | null {
  if (rxBps === null || linkBitsPerSec === null || linkBitsPerSec <= 0) {
    return null;
  }
  return ((rxBps * 8) / linkBitsPerSec) * 100;
}

/** Header subtitle: "en0 · 1.2 Gb/s link". Interface kind arrives with the schema field. */
export function networkSubtitle(
  primary: string | null,
  linkBitsPerSec: number | null
): string {
  if (primary === null) return "No active interface";
  if (linkBitsPerSec === null) return primary;
  return `${primary} · ${formatRate(linkBitsPerSec / 8, { units: "Mbps" })} link`;
}
