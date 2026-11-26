import {
  type Accent,
  Card,
  InlineBar,
  MeterTrack,
  MirrorBars,
  StackBar,
  StatusDot,
  StreamArea,
} from "@statglass/widgets";
import { type ReactNode, useId, useState } from "react";
import { Chevron, Screen } from "./chrome";
import {
  type DemoHost,
  formatRate,
  type HostSeries,
  percentCeiling,
  rateCeiling,
} from "./phone-data";
import styles from "./phone.module.css";

const WINDOW = 60;
const LABEL = "text-[13px] leading-4 font-normal text-muted-foreground";

interface ModuleProps {
  accent: Accent;
  title: string;
  value: string;
  unit?: string;
  open: boolean;
  onToggle: () => void;
  /** Opens the module's page; the whole card is then the button. */
  onOpen?: () => void;
  children: ReactNode;
}

/**
 * The phone's module card: accent swatch, title and headline value, with a
 * chevron that folds the body away. The desktop popover's card puts its
 * toggle on the left; the phone's sits by the value, under the thumb.
 */
function ModuleCard({
  accent,
  title,
  value,
  unit,
  open,
  onToggle,
  onOpen,
  children,
}: ModuleProps) {
  const id = useId();
  return (
    <Card
      accent={accent}
      variant="chart"
      labelledBy={id}
      className={`${onOpen ? styles.press : ""} relative flex flex-col gap-2.5 p-3`}
    >
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 rounded-mark"
          style={{ background: `var(--color-${accent})` }}
          aria-hidden="true"
        />
        {onOpen ? (
          <button
            id={id}
            type="button"
            onClick={onOpen}
            className="flex-1 text-left text-[15px] leading-5 font-semibold outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {title}
          </button>
        ) : (
          <h4 id={id} className="flex-1 text-[15px] leading-5 font-semibold">
            {title}
          </h4>
        )}
        <span className="figures-display text-[17px] leading-[22px]">
          {value}
          {unit && (
            <span className="text-[13px] text-muted-foreground">{unit}</span>
          )}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          onClick={onToggle}
          className="relative z-10 -m-2 flex size-9 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron open={open} />
        </button>
      </div>
      {open && children}
    </Card>
  );
}

function CpuCard({
  data,
  tEndMs,
  ...card
}: Pick<ModuleProps, "open" | "onToggle" | "onOpen"> & {
  data: HostSeries;
  tEndMs: number;
}) {
  const cpu = data.cpu.slice(-WINDOW);
  const now = cpu.at(-1) ?? 0;
  const yMax = percentCeiling(cpu);
  return (
    <ModuleCard
      accent="cpu"
      title="CPU"
      value={`${Math.round(now)}%`}
      {...card}
    >
      <StreamArea
        series={[{ key: "cpu", values: cpu, step: 1 }]}
        tEndMs={tEndMs}
        intervalMs={1000}
        yMax={yMax}
        accent="cpu"
        height={64}
        ceilingLabel={`${yMax}%`}
        windowLabel="60s"
        ariaLabel={`CPU, last minute, now ${Math.round(now)}%`}
      />
      <div className="flex flex-col gap-1.5">
        <InlineBar
          label="User"
          value={`${(now * 0.7).toFixed(1)}%`}
          fraction={(now * 0.7) / 100}
          layout="row"
        />
        <InlineBar
          label="System"
          value={`${(now * 0.3).toFixed(1)}%`}
          fraction={(now * 0.3) / 100}
          rampStep={2}
          layout="row"
        />
      </div>
    </ModuleCard>
  );
}

function MemoryCard({
  host,
  data,
  ...card
}: Pick<ModuleProps, "open" | "onToggle"> & {
  host: DemoHost;
  data: HostSeries;
}) {
  const used = ((data.memory.at(-1) ?? 0) / 100) * host.memoryGb;
  const gb = (v: number) => `${v.toFixed(1)} GB`;
  const parts = [
    { key: "wired", label: "Wired", share: 0.24, step: 1 },
    { key: "app", label: "App", share: 0.62, step: 2 },
    { key: "compressed", label: "Compressed", share: 0.14, step: 3 },
  ] as const;
  const pressure = Math.round(Math.max(8, (used / host.memoryGb) * 70 - 6));
  return (
    <ModuleCard
      accent="mem"
      title="Memory"
      value={used.toFixed(1)}
      unit={` / ${host.memoryGb} GB`}
      {...card}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className={LABEL}>Pressure · normal</span>
          <span className="figures text-[13px]">{pressure}%</span>
        </div>
        <MeterTrack
          fraction={pressure / 100}
          fill="var(--color-mem)"
          height="h-1.5"
        />
      </div>
      <StackBar
        segments={[
          ...parts.map((p) => ({
            key: p.key,
            label: p.label,
            value: gb(used * p.share),
            fraction: (used * p.share) / host.memoryGb,
            step: p.step,
          })),
          {
            key: "free",
            label: "Free",
            value: gb(host.memoryGb - used),
            fraction: (host.memoryGb - used) / host.memoryGb,
            step: "track" as const,
          },
        ]}
        showLegend
        legendColumns={1}
      />
    </ModuleCard>
  );
}

function GpuCard({
  data,
  tEndMs,
  ...card
}: Pick<ModuleProps, "open" | "onToggle"> & {
  data: HostSeries;
  tEndMs: number;
}) {
  const gpu = data.gpu.slice(-WINDOW);
  const now = gpu.at(-1) ?? 0;
  const stats = [
    ["Freq", `${(0.4 + now / 70).toFixed(1)} GHz`],
    ["Power", `${(0.3 + now / 12).toFixed(1)} W`],
    ["Render", `${Math.round(now * 0.9)}%`],
  ];
  return (
    <ModuleCard
      accent="gpu"
      title="GPU"
      value={`${Math.round(now)}%`}
      {...card}
    >
      <StreamArea
        series={[{ key: "gpu", values: gpu, step: 1 }]}
        tEndMs={tEndMs}
        intervalMs={1000}
        yMax={100}
        accent="gpu"
        height={44}
        ceilingLabel="100%"
        windowLabel="60s"
        ariaLabel={`GPU, last minute, now ${Math.round(now)}%`}
      />
      <dl className="grid grid-cols-3 gap-2">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className={LABEL}>{label}</dt>
            <dd className="figures text-[15px]">{value}</dd>
          </div>
        ))}
      </dl>
    </ModuleCard>
  );
}

function NetworkCard({
  data,
  tEndMs,
  ...card
}: Pick<ModuleProps, "open" | "onToggle"> & {
  data: HostSeries;
  tEndMs: number;
}) {
  const up = data.up.slice(-WINDOW);
  const down = data.down.slice(-WINDOW);
  return (
    <ModuleCard
      accent="net"
      title="Network"
      value={`↑ ${formatRate(up.at(-1) ?? 0)} · ↓ ${formatRate(down.at(-1) ?? 0)}`}
      {...card}
    >
      <p className={LABEL}>All interfaces</p>
      <MirrorBars
        up={up}
        down={down}
        upMax={rateCeiling(up)}
        downMax={rateCeiling(down)}
        intervalMs={1000}
        tEndMs={tEndMs}
        accent="net"
        upHeight={22}
        downHeight={34}
        ariaLabel="Network, last minute: upload above, download below"
      />
      <div className={`${LABEL} flex justify-between`}>
        <span>↑ Upload</span>
        <span>↓ Download</span>
      </div>
    </ModuleCard>
  );
}

/** A host's page: its module cards, live. */
export function HostScreen({
  host,
  data,
  tEndMs,
  onOpenCpu,
  back,
}: {
  host: DemoHost;
  data: HostSeries;
  tEndMs: number;
  onOpenCpu: () => void;
  back: ReactNode;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({
    power: true,
  });
  const card = (key: string) => ({
    open: !closed[key],
    onToggle: () => setClosed((c) => ({ ...c, [key]: !c[key] })),
  });
  const power =
    4 + (data.cpu.at(-1) ?? 0) * 0.2 + (data.gpu.at(-1) ?? 0) * 0.08;
  return (
    <Screen title={host.name} left={back}>
      <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[13px] font-normal text-secondary-foreground">
        <StatusDot state="live" />
        Live · 1s
      </p>
      <div className="flex flex-col gap-3">
        <CpuCard
          data={data}
          tEndMs={tEndMs}
          onOpen={onOpenCpu}
          {...card("cpu")}
        />
        <MemoryCard host={host} data={data} {...card("memory")} />
        {host.gpu && <GpuCard data={data} tEndMs={tEndMs} {...card("gpu")} />}
        {host.kind === "mac" && (
          <ModuleCard
            accent="power"
            title="Power & battery"
            value={`${power.toFixed(1)} W`}
            unit=" system · 87%"
            {...card("power")}
          >
            <InlineBar
              label="Battery"
              value="87%"
              fraction={0.87}
              layout="row"
            />
          </ModuleCard>
        )}
        <NetworkCard data={data} tEndMs={tEndMs} {...card("network")} />
      </div>
    </Screen>
  );
}
