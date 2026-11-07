import { formatPercent, formatRate } from "@core/format";
import { keyByLabel, labelValues } from "@core/series-key";
import { useMemo } from "react";
import { BRUSH_SCOPE_ATTR } from "~/components/brush-overlay";
import { NETWORK_HERO } from "~/components/charts/module-hero";
import { InterfaceTable } from "~/components/interface-table";
import { LiveMirrorChart } from "~/components/live-mirror-chart";
import { ModulePage } from "~/components/module-page";
import { RangeTotalsStrip } from "~/components/range-totals-strip";
import { SectionCard } from "~/components/section-card";
import { useChartWindow } from "~/hooks/use-chart-window";
import { useGapBands } from "~/hooks/use-gap-bands";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useUsageHistorical } from "~/hooks/use-module-end";
import { useProcessNetwork } from "~/hooks/use-process-interest";
import { useHeld, useLayout } from "~/hooks/use-ring";
import { useUnits } from "~/hooks/use-units";
import { useNetwork, usePrimaryIface } from "~/stores/live-selectors";
import { useSettings } from "~/stores/settings-store";
import { StatList } from "~/widgets/stat-list";
import { AddressLine } from "./_components/address-line";
import { AppsCard } from "./_components/apps-card";
import { AppsNowCard } from "./_components/apps-now-card";
import { SelectionSummary } from "./_components/selection-summary";
import { interfaceRows, networkSubtitle, ofLink } from "./_lib/network";

const NO_KEYS: readonly string[] = [];
const linkRateKey = keyByLabel("net.link_rate", "iface");

/**
 * Network (plan 4.11): the Overview Network card and the popover's
 * mirrored bars at page size, laid out like the CPU page. The throughput chart is
 * the page's dominant region. The header names the primary interface and
 * its local and public addresses, each copied on click (D-093). With per-process
 * network (D-081, D-089) the chart is brushable and an Apps card with bytes
 * per app over the selection sits between it and the interfaces; without it
 * neither is there. With Network history off the card shows live rates only
 * and the chart has no brush. The window is the shared chart window
 * (D-091); the default is 15m.
 */
export default function NetworkRoute() {
  const local = useIsLocalHost();
  // Null until settings load: the page waits rather than draw a span it would
  // redo, and the Apps card reads nothing.
  const chartWindow = useChartWindow();
  const gaps = useGapBands("network", chartWindow);
  const units = useUnits();
  const net = useNetwork();
  const primary = usePrimaryIface();
  const layout = useLayout();
  const rxKeys = layout?.byMetric.get("net.rx") ?? NO_KEYS;
  const txKeys = layout?.byMetric.get("net.tx") ?? NO_KEYS;
  const ifaces = useMemo(
    () => labelValues(layout?.series ?? [], "net.rx", "iface"),
    [layout]
  );
  const linkKey = linkRateKey(primary ?? "");
  const heldKeys = useMemo(
    () => [...rxKeys, ...txKeys, linkKey],
    [rxKeys, txKeys, linkKey]
  );
  const held = useHeld(heldKeys);
  const link = primary === null ? null : (held[linkKey] ?? null);
  const rate = (v: number | null) => formatRate(v, { units: units.rate });
  const perProcess = useProcessNetwork();
  // Null until settings arrive: neither card nor brush until then, so a
  // history that is off is never queried and never flashes on.
  const history = useSettings((s) => s.history.network_history !== false);
  const brush = perProcess && history === true;

  return (
    <ModulePage
      title="Network"
      subtitle={
        <>
          {networkSubtitle(primary, link)}
          {local && <AddressLine primary={primary} />}
        </>
      }
    >
      {(windowMs) => (
        <>
          <div {...{ [BRUSH_SCOPE_ATTR]: "" }} className="contents">
            <SectionCard
              accent="net"
              title="Throughput"
              hiddenTitle
              className="gap-4"
            >
              <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
                <StatList
                  hero={{ label: "↓ Download", value: rate(net.rx) }}
                  items={[
                    { label: "↑ Upload", value: rate(net.tx) },
                    {
                      label: "Of link",
                      value: formatPercent(ofLink(net.rx, link), {
                        decimals: 1,
                      }),
                    },
                  ]}
                />
                <RangeTotalsStrip
                  windowMs={windowMs}
                  totals={NETWORK_HERO.totals}
                  testId="network-totals"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <LiveMirrorChart
                  brush={brush}
                  gaps={gaps}
                  {...NETWORK_HERO}
                  windowMs={windowMs}
                  accent="net"
                  format={(v) => formatRate(v, { units: units.rate })}
                />
                {brush && <SelectionSummary windowMs={windowMs} />}
              </div>
            </SectionCard>
            <NetworkApps
              windowMs={windowMs}
              local={local}
              perProcess={perProcess}
              history={history}
            />
          </div>
          <SectionCard
            accent="net"
            origin="br"
            title="Interfaces"
            variant="default"
          >
            <InterfaceTable
              rows={interfaceRows(ifaces, held)}
              units={units.rate}
            />
          </SectionCard>
        </>
      )}
    </ModulePage>
  );
}

function NetworkApps({
  windowMs,
  local,
  perProcess,
  history,
}: {
  windowMs: number;
  local: boolean;
  perProcess: boolean;
  history: boolean | null;
}) {
  const historical = useUsageHistorical(windowMs);
  if (historical) return <AppsCard windowMs={windowMs} />;
  if (!perProcess || history === null) return null;
  return history && local ? <AppsCard windowMs={windowMs} /> : <AppsNowCard />;
}
