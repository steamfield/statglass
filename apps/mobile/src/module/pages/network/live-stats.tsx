import { formatPercent, formatRate } from "@core/format";
import type { HostId } from "@core/generated/types";
import { currentLayout, selectNetwork } from "@core/live-selectors";
import { interfaceRows, ofLink } from "@core/network-lines";
import { keyByLabel, labelValues } from "@core/series-key";
import { useMemo } from "react";
import { shallow } from "zustand/shallow";
import { useHostLive } from "@/data/live";
import { StatStrip } from "@/module/stat-strip";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";

const NO_STATS = [] as const;
const rxKey = keyByLabel("net.rx", "iface");
const txKey = keyByLabel("net.tx", "iface");

export function NetworkStats({
  host,
  live,
  link,
}: {
  host: HostId;
  live: boolean;
  link: number | null;
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
