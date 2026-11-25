import { isPresent, MISSING, type RateUnits, rateParts } from "@core/format";
import type { NetworkSelection } from "@core/live-selectors";
import type { StatListItem } from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

function direction(
  label: string,
  value: number | null,
  units: RateUnits
): StatListItem {
  return isPresent(value)
    ? { label, ...rateParts(value, { units }) }
    : { label, value: MISSING };
}

export function networkCard(
  sel: NetworkSelection,
  { rate = "MBps", primaryIface = null, chartLabel }: CardSource
): CardContent & {
  headline: string;
  spokenHeadline: string;
  subtitle: string;
} {
  const upload = direction("↑ Upload", sel.tx, rate);
  const download = direction("↓ Download", sel.rx, rate);
  const tx =
    upload.unit === undefined ? upload.value : `${upload.value} ${upload.unit}`;
  const rx =
    download.unit === undefined
      ? download.value
      : `${download.value} ${download.unit}`;
  const subtitle =
    primaryIface === null
      ? "All interfaces"
      : `All interfaces · ${primaryIface}`;
  return {
    title: "Network",
    headline: `↑ ${tx} · ↓ ${rx}`,
    spokenHeadline: `Upload ${tx}, Download ${rx}`,
    subtitle,
    segments: [],
    items: [upload, download],
    bars: [],
    spoken: chartLabel ? `${subtitle}, ${chartLabel}` : subtitle,
  };
}
