/**
 * Popover module cards (plan 4.3) fed by the live store.
 * Each card reads its own module selector, so a frame that only moves CPU
 * values re-renders the CPU cards and nothing else.
 */
import { spanWords } from "@core/live-window";
import {
  BATTERY_TITLE,
  batteryCard,
  cpuCard,
  gpuCard,
  memoryCard,
  memoryFullLegend,
  networkCard,
  powerCard,
} from "@core/popover/cards";
import { mirrorSubject } from "~/components/charts/mirror-chart";
import { CopyValue } from "~/components/copy-value";
import { useAddresses } from "~/hooks/use-addresses";
import { useChartLabel } from "~/hooks/use-chart-label";
import { useCompactStream } from "~/hooks/use-compact-stream";
import { useHostRecord } from "~/hooks/use-host-record";
import { useModuleStates } from "~/hooks/use-module-states";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import { useReadFailure } from "~/hooks/use-read-failure";
import { useShownRingLoading } from "~/hooks/use-ring";
import { useScaledWindow } from "~/hooks/use-scaled-window";
import { useUnits } from "~/hooks/use-units";
import { useTransport } from "~/lib/transport-context";
import {
  useBattery,
  useCpu,
  useGpu,
  useMemory,
  useNetwork,
  usePower,
  usePowerSource,
  usePrimaryIface,
  useSeriesWindow,
} from "~/stores/live-selectors";
import { InlineBar } from "~/widgets/inline-bar";
import { MeterTrack } from "~/widgets/meter-track";
import { MirrorBars } from "~/widgets/mirror-bars";
import { ModuleCard } from "~/widgets/module-card";
import { StackBar } from "~/widgets/stack-bar";
import { StatList } from "~/widgets/stat-list";
import { StreamArea } from "~/widgets/stream-area";

import { CompactBattery, CompactPower } from "./compact-battery";

export interface PresentationProps {
  compact?: boolean;
  onToggle?: (() => void) | undefined;
}

/** Opens a card's module page in the dashboard window. */
function useOpen() {
  const transport = useTransport();
  return (href: string) => void transport.openDashboard(href);
}

const NET_WINDOW_MS = 48_000;
/** Smallest ceiling the network bars autoscale to, B/s (as on the Network page). */
const NET_MIN_CEILING = 100_000;

export function LiveCpuCard({ compact = false, onToggle }: PresentationProps) {
  const open = useOpen();
  const card = cpuCard(useCpu(), { compact });
  const stream = useCompactStream({
    seriesKey: "cpu.total",
    accent: "cpu",
    subject: card.title,
    now: card.headline,
    height: compact ? 14 : 52,
    bare: compact,
  });
  const notice = useReadFailure("cpu.total");
  return (
    <ModuleCard
      compact={compact}
      onToggle={onToggle}
      accent="cpu"
      title={card.title}
      href="/dashboard/cpu"
      onOpen={open}
      value={card.headline}
      notice={notice}
    >
      <StreamArea {...stream} />
      {!compact && (
        <div className="flex flex-col gap-[5px] pt-1.5">
          {card.bars.map((bar) => (
            <InlineBar key={bar.label} model={bar} />
          ))}
        </div>
      )}
    </ModuleCard>
  );
}

export function LiveMemoryCard({
  compact = false,
  onToggle,
}: PresentationProps) {
  const open = useOpen();
  const mem = useMemory();
  const host = useHostRecord();
  const notice = useReadFailure("mem.used");
  const totalBytes = host?.info.mem_total_bytes ?? null;
  const card = memoryCard(mem, {
    bytes: useUnits().bytes,
    totalBytes,
    compact: true,
  });
  const legend = compact ? null : memoryFullLegend(mem, totalBytes);
  return (
    <ModuleCard
      compact={compact}
      onToggle={onToggle}
      accent="mem"
      title={card.title}
      href="/dashboard/memory"
      onOpen={open}
      value={card.headline}
      unit={card.capacity === null ? undefined : ` ${card.capacity}`}
      notice={notice}
    >
      {legend ? (
        <>
          <InlineBar model={legend.pressure} />
          <StackBar
            showLegend
            legendColumns={2}
            segments={legend.segments}
            extraLegend={legend.items}
          />
        </>
      ) : (
        <div className="flex items-center gap-2">
          <MeterTrack fraction={card.usedFraction} className="flex-1" />
          {card.compactPressure && (
            <span className="whitespace-nowrap text-caption text-muted-foreground">
              {card.compactPressure}
            </span>
          )}
        </div>
      )}
    </ModuleCard>
  );
}

/**
 * GPU card. The third cell would be the GPU core count, but `HostInfo` has
 * no GPU core count yet, so the card shows the renderer utilization it can measure.
 */
export function LiveGpuCard({ compact = false, onToggle }: PresentationProps) {
  const open = useOpen();
  const card = gpuCard(useGpu(), {});
  const stream = useCompactStream({
    seriesKey: "gpu.util",
    accent: "gpu",
    subject: card.title,
    now: card.headline,
    height: compact ? 14 : 40,
    yMax: 100,
    bare: compact,
  });
  const notice = useReadFailure("gpu.util");
  return (
    <ModuleCard
      compact={compact}
      onToggle={onToggle}
      accent="gpu"
      title={card.title}
      href="/dashboard/gpu"
      onOpen={open}
      value={card.headline}
      notice={notice}
    >
      <StreamArea {...stream} />
      {!compact && <StatList layout="grid" items={card.items} />}
    </ModuleCard>
  );
}

/**
 * Power card: system watts, a stacked bar of CPU, GPU, ANE (hatched) and
 * DRAM with the rest of the system as track, and the four values with keys.
 */
export function LivePowerCard({
  compact = false,
  onToggle,
}: PresentationProps) {
  const open = useOpen();
  const card = powerCard(usePower(), {
    showBattery: useModuleStates().battery === "on",
  });
  const notice = useReadFailure("power.system");
  return (
    <ModuleCard
      compact={compact}
      onToggle={onToggle}
      accent="power"
      title={card.title}
      href="/dashboard/power"
      onOpen={open}
      value={card.headline}
      unit={` ${card.unit}`}
      notice={notice}
    >
      {compact ? (
        <CompactPower showBattery={card.hasBattery} />
      ) : (
        <>
          <StackBar segments={[...card.segments]} />
          <StatList layout="grid" items={card.items} />
          {card.hasBattery && <BatteryDetails />}
          {card.note && (
            <p className="m-0 font-normal text-label text-muted-foreground">
              {card.note}
            </p>
          )}
        </>
      )}
    </ModuleCard>
  );
}

/**
 * Network card: the totals over the reported interfaces (`net.rx_total`,
 * D-092). The header shows the local and public addresses (D-093), each
 * copyable without opening the page. Before the local address is read, or
 * without one (no network or an older host), the subtitle says the figures are
 * every interface's and names the one carrying the default route ("All
 * interfaces · en0"; "All interfaces" on a full-tunnel VPN).
 */
export function LiveNetworkCard({
  compact = false,
  onToggle,
}: PresentationProps) {
  const open = useOpen();
  const iface = usePrimaryIface();
  const { lan, publicIp, failure } = useAddresses(iface, !compact);
  const { rate: rateUnits } = useUnits();
  const rxKey = "net.rx_total";
  const txKey = "net.tx_total";
  const windowMs = useScaledWindow(NET_WINDOW_MS);
  const loading = useShownRingLoading(windowMs);
  const rx = useSeriesWindow(rxKey, windowMs);
  const tx = useSeriesWindow(txKey, windowMs);
  const card = networkCard(useNetwork(), {
    rate: rateUnits,
    primaryIface: iface,
  });
  // Held ceilings: per-tick maxima would rescale the bars every second.
  const upMax = useNiceCeiling(tx.values, tx.tEndMs, NET_MIN_CEILING, windowMs);
  const downMax = useNiceCeiling(
    rx.values,
    rx.tEndMs,
    NET_MIN_CEILING,
    windowMs
  );
  const ariaLabel = useChartLabel({
    subject: mirrorSubject({
      subject: card.title,
      upLabel: "Upload",
      downLabel: "Download",
    }),
    span: spanWords(windowMs, null),
  });
  const rxNotice = useReadFailure("net.rx_total");
  const txNotice = useReadFailure("net.tx_total");
  return (
    <ModuleCard
      compact={compact}
      onToggle={onToggle}
      notice={rxNotice ?? txNotice}
      accent="net"
      title={card.title}
      href="/dashboard/network"
      onOpen={open}
      value={compact ? card.headline : undefined}
      subtitle={compact ? undefined : card.subtitle}
      subtitleStyle="text"
      aside={compact ? undefined : networkAddresses(lan, publicIp, failure)}
    >
      {!compact && <StatList layout="grid" items={card.items} />}
      <MirrorBars
        loading={loading}
        up={tx.values}
        down={rx.values}
        intervalMs={rx.intervalMs}
        tEndMs={rx.tEndMs}
        accent="net"
        ariaLabel={ariaLabel}
        upMax={upMax}
        downMax={downMax}
        upHeight={compact ? 6 : 18}
        downHeight={compact ? 8 : 30}
      />
    </ModuleCard>
  );
}

/** Standalone battery when power monitoring is disabled or unavailable. */
export function LiveBatteryCard({
  compact = false,
  onToggle,
}: PresentationProps) {
  const open = useOpen();
  return (
    <ModuleCard
      compact={compact}
      onToggle={onToggle}
      accent="battery"
      title={BATTERY_TITLE}
      href="/dashboard/battery"
      onOpen={open}
    >
      {compact ? <CompactBattery /> : <BatteryDetails />}
    </ModuleCard>
  );
}

/** Battery readings shared by the combined and standalone cards. */
function BatteryDetails() {
  const card = batteryCard(useBattery(), { powerSource: usePowerSource() });
  const notice = useReadFailure("battery.charge");
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label text-muted-foreground">{card.title}</span>
        <span className="figures-display text-figure">{card.headline}</span>
      </div>
      {notice && (
        <p className="m-0 text-label text-muted-foreground">{notice}</p>
      )}
      <MeterTrack
        fraction={card.chargeFraction}
        fill="var(--color-battery)"
        height="h-1.5"
      />
      <StatList layout="grid" items={card.remainingItems} />
    </>
  );
}

function networkAddresses(
  lan: string | null,
  publicIp: { data?: string | undefined; isError: boolean },
  failure: string | undefined
) {
  if (failure !== undefined) {
    return <span title={failure}>Addresses unavailable</span>;
  }
  if (lan === null) return undefined;
  return (
    <>
      <CopyValue value={lan} label="local IP address" /> ·{" "}
      {publicIp.data ? (
        <CopyValue value={publicIp.data} label="public IP address" />
      ) : publicIp.isError ? (
        "public unavailable"
      ) : (
        "…"
      )}
    </>
  );
}
