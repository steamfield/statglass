import { countNoun } from "@core/format";
import { keyByLabel } from "@core/series-key";
import type { VolumeRow } from "~/components/volume-table";

/**
 * Volumes in display order: the boot container's mounts first, in the order
 * Rust lists them (`HostInfo.boot_mounts`, D-092), then the rest
 * alphabetically.
 */
const usedKey = keyByLabel("disk.used", "vol");
const freeKey = keyByLabel("disk.free", "vol");
const totalKey = keyByLabel("disk.total", "vol");

export function volumeRows(
  vols: readonly string[],
  held: Record<string, number | null>,
  bootMounts: readonly string[]
): VolumeRow[] {
  const rank = (v: string) => {
    const i = bootMounts.indexOf(v);
    return i === -1 ? bootMounts.length : i;
  };
  const order = (a: string, b: string) =>
    rank(a) - rank(b) || a.localeCompare(b);
  return [...vols].sort(order).map((vol) => ({
    id: vol,
    // Volume names ("Macintosh HD") are not in the schema; the mount point is.
    name: vol,
    usedBytes: held[usedKey(vol)] ?? null,
    freeBytes: held[freeKey(vol)] ?? null,
    totalBytes: held[totalKey(vol)] ?? null,
  }));
}

/** Header subtitle from what the layout has: "disk3 · 2 volumes". */
export function diskSubtitle(
  devices: readonly string[],
  volumeCount: number
): string {
  const parts: string[] = [];
  if (devices.length > 0) parts.push(devices.join(", "));
  parts.push(countNoun(volumeCount, "volume", "volumes"));
  return parts.join(" · ");
}
