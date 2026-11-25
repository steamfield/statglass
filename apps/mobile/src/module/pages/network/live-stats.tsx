import {
  formatBytes,
  formatPercent,
  formatRate,
  formatSpan,
  MISSING,
} from "@core/format";
import type { HostId, SeriesHistoryStats } from "@core/generated/types";
import { currentLayout, selectNetwork } from "@core/live-selectors";
import { NETWORK_HERO } from "@core/module-hero";
import { interfaceRows, ofLink } from "@core/network-lines";
import { measuredShort } from "@core/range-totals";
import { keyByLabel, labelValues } from "@core/series-key";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { shallow } from "zustand/shallow";
import type { AddressRow } from "@/data/addresses";
import { useHostLive } from "@/data/live";
import { StatStrip } from "@/module/stat-strip";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";

const NO_STATS = [] as const;

/** "↓ Downloaded · 1 h": bytes from the host's range totals (D-155), never summed here. */
function rangeTotals(stats: readonly SeriesHistoryStats[], spanMs: number) {
  const scope = formatSpan(spanMs);
  return NETWORK_HERO.totals.map(({ metric, label }) => {
    const stat = stats.find(
      ({ key }) => key.metric === metric && key.labels.length === 0
    );
    const integral = stat?.integral ?? null;
    const measured = stat?.measured_ms ?? null;
    const short =
      measured === null
        ? null
        : measuredShort({ measured_ms: measured }, spanMs);
    return {
      label: `${label} · ${scope}`,
      value:
        integral === null
          ? MISSING
          : `${formatBytes(integral)}${short === null ? "" : ` in ${short}`}`,
    };
  });
}
const rxKey = keyByLabel("net.rx", "iface");
const txKey = keyByLabel("net.tx", "iface");

export function NetworkStats({
  host,
  live,
  link,
  stats,
  spanMs,
}: {
  host: HostId;
  live: boolean;
  link: number | null;
  /** The history answer's per-series stats, for the range totals. */
  stats: readonly SeriesHistoryStats[] | undefined;
  spanMs: number;
}) {
  const { rx, tx } = useHostLive(host, selectNetwork, shallow);
  const download = live ? rx : null;
  return (
    <StatStrip
      lead={{ label: "Download", value: formatRate(download) }}
      items={[
        { label: "Upload", value: formatRate(live ? tx : null) },
        {
          label: "Of link",
          value: formatPercent(ofLink(download, link), { decimals: 1 }),
        },
        ...rangeTotals(stats ?? NO_STATS, spanMs),
      ]}
      stats={NO_STATS}
    />
  );
}

export function InterfaceList({ host, live }: { host: HostId; live: boolean }) {
  const layout = useHostLive(host, currentLayout);
  const ifaces = useMemo(
    () => labelValues(layout?.series ?? [], "net.rx", "iface"),
    [layout]
  );
  const keys = useMemo(
    () => ifaces.flatMap((iface) => [rxKey(iface), txKey(iface)]),
    [ifaces]
  );
  const values = useHostLive(
    host,
    ({ held }) =>
      Object.fromEntries(
        keys.map((key) => [key, live ? (held[key] ?? null) : null])
      ),
    shallow
  );
  const rows = interfaceRows(ifaces, values);
  return (
    <ListSection title="Interfaces">
      {rows.length === 0 ? (
        <Text variant="label">No interfaces reported</Text>
      ) : (
        <GroupedList>
          {rows.map(({ id, rxBps, txBps }) => (
            <ListRow
              key={id}
              title={id}
              subtitle={`Download ${formatRate(rxBps)} · Upload ${formatRate(txBps)}`}
            />
          ))}
        </GroupedList>
      )}
    </ListSection>
  );
}

/** The host's addresses, one labelled row each, under Interfaces. */
/** Longest value that fits the row's trailing column at the default text size. */
const INLINE_ADDRESS_CHARS = 17;

export function AddressList({ rows }: { rows: readonly AddressRow[] }) {
  const { fontScale } = useWindowDimensions();
  if (rows.length === 0) return null;
  return (
    <ListSection title="Addresses">
      <GroupedList>
        {rows.map(({ label, value, hint }) => {
          // A long IPv6 address, or any address at accessibility sizes, moves
          // under its label (as the Interfaces rows read) so it never breaks
          // mid-address in the narrow trailing column.
          const stacked =
            fontScale >= 1.35 || value.length > INLINE_ADDRESS_CHARS;
          return (
            <ListRow
              key={`${label} ${value}`}
              title={label}
              {...(stacked ? { subtitle: value } : { value })}
              {...(hint !== undefined && { accessibilityHint: hint })}
            />
          );
        })}
      </GroupedList>
    </ListSection>
  );
}
