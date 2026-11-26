import { MirrorBars, StatusDot, StreamArea } from "@statglass/widgets";
import type { ReactNode } from "react";
import { GearButton, HostIcon, Screen } from "./chrome";
import {
  DEMO_HOSTS,
  type DemoHost,
  formatRate,
  type HostSeries,
  percentCeiling,
  rateCeiling,
} from "./phone-data";
import styles from "./phone.module.css";

/** The hosts list shows each host's last minute. */
const WINDOW = 60;

const LANE_LABEL =
  "figures text-[11px] leading-[14px] font-normal whitespace-nowrap text-muted-foreground";

function Figure({
  label,
  value,
  ink,
}: {
  label: string;
  value: string;
  ink: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] leading-4 font-normal text-muted-foreground">
        {label}
      </p>
      <p
        className="figures text-[17px] leading-[22px] font-medium"
        style={{ color: ink }}
      >
        {value}
      </p>
    </div>
  );
}

function Lane({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <div className={LANE_LABEL}>{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function LiveHostCard({
  host,
  series,
  tEndMs,
  onOpen,
}: {
  host: DemoHost;
  series: HostSeries;
  tEndMs: number;
  onOpen: () => void;
}) {
  const cpu = series.cpu.slice(-WINDOW);
  const memory = series.memory.slice(-WINDOW);
  const up = series.up.slice(-WINDOW);
  const down = series.down.slice(-WINDOW);
  const cpuMax = percentCeiling(cpu);
  const memMax = percentCeiling(memory);
  const upMax = rateCeiling(up);
  const downMax = rateCeiling(down);
  const cpuNow = `${Math.round(cpu.at(-1) ?? 0)}%`;
  const memNow = `${Math.round(memory.at(-1) ?? 0)}%`;
  const netNow = formatRate((down.at(-1) ?? 0) + (up.at(-1) ?? 0));
  return (
    // The name's button stretches over the card, so the whole card opens
    // the host while the charts stay out of the button's content.
    <div
      className={`${styles.press} relative flex w-full flex-col gap-3 rounded-card border border-border bg-card p-3`}
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-foreground">
          <HostIcon kind={host.kind} />
        </span>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${host.name}, live. CPU ${cpuNow}, memory ${memNow}, network ${netNow}`}
          className="flex-1 truncate text-left text-[17px] leading-[22px] font-semibold outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {host.name}
        </button>
        <span className="flex items-center gap-1.5 text-[13px] font-normal text-muted-foreground">
          <StatusDot state="live" />
          Live
        </span>
      </div>
      <div className="grid w-full grid-cols-3 gap-2" aria-hidden="true">
        <Figure label="CPU" value={cpuNow} ink="var(--color-cpu)" />
        <Figure label="Memory" value={memNow} ink="var(--color-mem)" />
        <Figure label="Network" value={netNow} ink="var(--color-net)" />
      </div>
      <div className="flex w-full flex-col gap-2" aria-hidden="true">
        <Lane label={`${cpuMax}%`}>
          <StreamArea
            series={[{ key: "cpu", values: cpu, step: 1 }]}
            tEndMs={tEndMs}
            intervalMs={1000}
            yMax={cpuMax}
            accent="cpu"
            height={34}
          />
        </Lane>
        <Lane label={`${memMax}%`}>
          <StreamArea
            series={[{ key: "mem", values: memory, step: 1 }]}
            tEndMs={tEndMs}
            intervalMs={1000}
            yMax={memMax}
            accent="mem"
            height={34}
          />
        </Lane>
        <Lane
          label={
            <>
              ↑ {formatRate(upMax)}
              <br />↓ {formatRate(downMax)}
            </>
          }
        >
          <MirrorBars
            up={up}
            down={down}
            upMax={upMax}
            downMax={downMax}
            intervalMs={1000}
            tEndMs={tEndMs}
            accent="net"
            upHeight={12}
            downHeight={20}
            ariaLabel=""
          />
        </Lane>
      </div>
    </div>
  );
}

function DisabledHostRow({ host }: { host: DemoHost }) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-card px-3 py-3.5">
      <span className="text-muted-foreground">
        <HostIcon kind={host.kind} />
      </span>
      <span className="flex-1 truncate text-[17px] leading-[22px] font-semibold">
        {host.name}
      </span>
      <span className="text-[13px] font-normal text-muted-foreground">
        Disabled
      </span>
    </div>
  );
}

/** The app's first screen: every saved host with its last minute. */
export function HostsScreen({
  series,
  tEndMs,
  onOpen,
}: {
  series: Record<string, HostSeries>;
  tEndMs: number;
  onOpen: (host: string) => void;
}) {
  return (
    <Screen
      title="Hosts"
      left={
        <span className="flex h-8 items-center rounded-full border border-border px-3 text-[13px] font-normal text-secondary-foreground">
          Demo
        </span>
      }
      right={<GearButton />}
    >
      <ul className="flex flex-col gap-3">
        {DEMO_HOSTS.map((host) => {
          const data = series[host.id];
          return (
            <li key={host.id}>
              {host.enabled && data ? (
                <LiveHostCard
                  host={host}
                  series={data}
                  tEndMs={tEndMs}
                  onOpen={() => onOpen(host.id)}
                />
              ) : (
                <DisabledHostRow host={host} />
              )}
            </li>
          );
        })}
      </ul>
    </Screen>
  );
}
