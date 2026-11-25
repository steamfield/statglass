import {
  isPresent,
  joinQuantity,
  MISSING,
  type RateUnits,
  rateParts,
} from "@core/format";
import type { NetworkSelection } from "@core/live-selectors";
import type { StatListItem } from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

type RateItem = StatListItem & { joinedValue: string };

function direction(
  label: string,
  value: number | null,
  units: RateUnits
): RateItem {
  if (!isPresent(value)) return { label, value: MISSING, joinedValue: MISSING };
  const parts = rateParts(value, { units });
  return { label, ...parts, joinedValue: joinQuantity(parts) };
}

export function networkCard(
  sel: NetworkSelection,
  { rate = "MBps", primaryIface = null, chartLabel }: CardSource
): Omit<CardContent, "items"> & {
  headline: string;
  spokenHeadline: string;
  subtitle: string;
  items: readonly RateItem[];
} {
  const upload = direction("↑ Upload", sel.tx, rate);
  const download = direction("↓ Download", sel.rx, rate);
  const tx = upload.joinedValue;
  const rx = download.joinedValue;
  const subtitle =
    primaryIface === null
      ? "All interfaces"
      : `All interfaces · ${primaryIface}`;
  return {
    title: "Network",
    headline: `↑ ${tx} · ↓ ${rx}`,
    get spokenHeadline() {
      return `Upload ${tx}, Download ${rx}`;
    },
    subtitle,
    segments: [],
    items: [upload, download],
    bars: [],
    get spoken() {
      return chartLabel ? `${subtitle}, ${chartLabel}` : subtitle;
    },
  };
}
