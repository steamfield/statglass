import { Card, HeatMatrix, Legend, StreamArea } from "@statglass/widgets";
import { type ReactNode, useState } from "react";
import { Screen } from "./chrome";
import {
  CORE_BUCKETS,
  type DemoHost,
  type HostSeries,
  LIVE_LENGTH,
} from "./phone-data";

const RANGES = [
  {
    key: "5m",
    label: "5m",
    xTicks: ["−5m", "−4m", "−3m", "−2m", "−1m", "now"],
  },
  { key: "1h", label: "1h", xTicks: ["−60m", "−45m", "−30m", "−15m", "now"] },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const LABEL = "text-[13px] leading-4 font-normal text-muted-foreground";

/** UIKit's segmented control: a thumb that slides to the chosen segment. */
function Segmented({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}) {
  const index = RANGES.findIndex((r) => r.key === value);
  return (
    <div
      role="radiogroup"
      aria-label="Chart range"
      className="relative grid grid-cols-2 rounded-[10px] bg-white/[0.07] p-0.5"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[8px] bg-white/[0.14] shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-(--motion-fast) ease-(--ease-out)"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {RANGES.map((range) => (
        <button
          key={range.key}
          type="button"
          role="radio"
          aria-checked={range.key === value}
          onClick={() => onChange(range.key)}
          className={`relative h-8 text-[13px] ${range.key === value ? "font-semibold text-foreground" : "font-normal text-secondary-foreground"}`}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className={LABEL}>{label}</dt>
      <dd className="figures text-[15px] leading-5">{value}</dd>
    </div>
  );
}

const mean = (v: readonly number[]) =>
  v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

/** The CPU module page: a range switch, the total, its chart and every core. */
export function CpuScreen({
  host,
  data,
  tEndMs,
  back,
}: {
  host: DemoHost;
  data: HostSeries;
  tEndMs: number;
  back: ReactNode;
}) {
  const [range, setRange] = useState<RangeKey>("5m");
  const values = range === "5m" ? data.cpu.slice(-LIVE_LENGTH) : data.cpuHour;
  const now = data.cpu.at(-1) ?? 0;
  const cores = host.cores;
  const coreSummary =
    cores.e > 0
      ? `${cores.p} performance + ${cores.e} efficiency cores`
      : `${cores.p} cores`;
  const load = (now / 100) * (cores.p + cores.e) * 0.3;
  const rows = data.coreHour.map((buckets, i) => {
    const efficiency = i >= cores.p;
    const label = efficiency ? `E${i - cores.p}` : cores.e ? `P${i}` : `${i}`;
    return {
      id: label,
      label,
      group: efficiency ? "e" : "p",
      now: data.cores[i] ?? null,
      buckets,
    };
  });
  const spec = RANGES.find((r) => r.key === range) ?? RANGES[0];
  return (
    <Screen
      title="CPU"
      subtitle={`${host.chip} · ${coreSummary}`}
      largeTitle={false}
      left={back}
    >
      <div className="flex flex-col gap-4 pt-2">
        <Segmented value={range} onChange={setRange} />
        <div>
          <p className={LABEL}>Total</p>
          <p className="figures-display text-[34px] leading-[40px]">
            {Math.round(now)}%
          </p>
        </div>
        <dl className="grid grid-cols-4 gap-x-3 gap-y-2">
          <Stat label="User" value={`${(now * 0.7).toFixed(1)}%`} />
          <Stat label="System" value={`${(now * 0.3).toFixed(1)}%`} />
          <Stat label="Idle" value={`${(100 - now).toFixed(1)}%`} />
          <Stat label="Load avg" value={load.toFixed(2)} />
          <Stat label="Avg" value={`${mean(values).toFixed(1)}%`} />
          <Stat label="Peak" value={`${Math.round(Math.max(...values))}%`} />
        </dl>
        <Card
          accent="cpu"
          variant="chart"
          ariaLabel="CPU total"
          className="flex flex-col gap-2 p-3"
        >
          <Legend items={[{ label: "Total", step: 1 }]} />
          <StreamArea
            series={[{ key: "total", values, step: 1 }]}
            tEndMs={
              range === "5m" ? tEndMs : Math.floor(data.ticks / 10) * 10_000
            }
            intervalMs={range === "5m" ? 1000 : 10_000}
            yMax={100}
            accent="cpu"
            height={150}
            gridlines={[50]}
            yTicks={[
              { value: 100, label: "100%" },
              { value: 50, label: "50%" },
              { value: 0, label: "0%" },
            ]}
            xTicks={spec.xTicks}
            ariaLabel={`CPU total, last ${range === "5m" ? "5 minutes" : "hour"}`}
          />
        </Card>
        <Card
          accent="cpu"
          variant="chart"
          origin="tr"
          ariaLabel="Per-core load, last hour"
          className="flex flex-col gap-2 p-3"
        >
          <p className="text-[15px] leading-5 font-semibold">
            Per-core load, last hour
          </p>
          <HeatMatrix
            rows={rows}
            scale={{ min: 0, max: 100 }}
            formatNow={(v) => `${Math.round(v)}%`}
            labelWidth={28}
            bucketMs={3_600_000 / CORE_BUCKETS}
            windowMs={3_600_000}
            accent="cpu"
            ariaLabel="Per-core load over the last hour"
          />
        </Card>
      </div>
    </Screen>
  );
}
