import { cpuPowerNote } from "@core/cpu-power-source";
import { eventLabel } from "@core/events";
import { formatWatts, formatWattsFine } from "@core/format";
import { parseLabels } from "@core/series-key";
import { useMemo } from "react";
import { brushScopeProps } from "~/components/brush-overlay";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { InlineMessage } from "~/components/inline-message";
import { POWER_HERO } from "~/components/module-hero";
import { RangeTotalsStrip } from "~/components/range-totals-strip";
import { SectionCard } from "~/components/section-card";
import { useEvents } from "~/hooks/use-events";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useHeld, useLayout } from "~/hooks/use-ring";
import { type SeriesFocus, useSeriesFocus } from "~/hooks/use-series-focus";
import { usePowerComponents } from "~/stores/live-selectors";
import { DASHBOARD_CHART_HEIGHT } from "~/widgets/chart-frame";
import { Legend, type LegendItem } from "~/widgets/legend";
import { StatList } from "~/widgets/stat-list";
import type { StreamAreaProps } from "~/widgets/stream-area";
import {
  type AppLine,
  type AppLines,
  useAppLines,
} from "../_hooks/use-app-lines";

const COMPONENTS = [
  { metric: "power.cpu", label: "CPU" },
  { metric: "power.gpu", label: "GPU" },
  { metric: "power.ane", label: "ANE" },
  { metric: "power.dram", label: "DRAM" },
] as const;
const HELD = [
  ...POWER_HERO.keys,
  ...COMPONENTS.map((c) => c.metric),
  "power.cpu_source",
];
const HEIGHT = DASHBOARD_CHART_HEIGHT;
/** A `power.sensor{name=…}` key's rail name, as the kernel labels it. */
const railName = (key: string) => parseLabels(key).name ?? "";
/**
 * App lines cycle the lighter ramp steps; the second time round they are
 * dashed, so no two lines look the same. Legend focus tells them apart too.
 */
const APP_STEPS = [2, 3, 4, 2, 3] as const;
const appStyle = (i: number) => ({
  step: APP_STEPS[i % APP_STEPS.length] ?? 2,
  dashed: i >= 3,
});
/**
 * System draw over the chart window (D-091) with the top apps by energy as
 * lines under it (D-093), and the components' live watts in the strip.
 *
 * This replaces a stack of CPU, GPU, ANE and DRAM. That stack drew any
 * component measured once in the window and broke wherever one was missing;
 * on macOS 27 ANE, DRAM and package are emitted only when the PMP counters
 * move (D-043), so it collapsed into isolated round-capped dots. The line
 * here is `power.system`, measured every tick; the PMP components stay
 * figures that read "—" while gapped. The chart is brushable (D-099): the
 * average and peak and the Energy by app table follow the selection.
 *
 * A host that splits power by no component (a Linux agent, D-116) shows its
 * power rails in the strip instead, as the kernel names them.
 */
export function PowerDrawCard({ windowMs }: { windowMs: number }) {
  const components = usePowerComponents();
  const railKeys = useLayout()?.byMetric.get("power.sensor") ?? [];
  const rails = components ? [] : railKeys;
  const v = useHeld([...HELD, ...rails]);
  const system = v["power.system"] ?? null;
  const chart = useModuleChart(POWER_HERO.keys, windowMs, POWER_HERO.module, {
    brush: true,
  });
  const { series, span } = chart;
  const values = series.values["power.system"] ?? [];
  const lines = useAppLines(windowMs, {
    tEndMs: series.tEndMs,
    intervalMs: series.intervalMs,
    length: values.length,
  });
  const annotations = useSpikeAnnotations(windowMs);
  const apps = lines.kind === "ok" ? lines.apps : [];
  const focus = useSeriesFocus(apps.map((a) => a.name));
  const cpuNote = cpuPowerNote(v["power.cpu_source"] ?? null);

  // System's figures are in the strip and the range totals; no value here.
  const legend: LegendItem[] = [
    { label: "System", step: 1 },
    ...apps.map((a, i) => ({
      label: a.name,
      value: formatWattsFine(a.avg),
      ...appStyle(i),
      ...focus.legendItemProps(a.name),
    })),
  ];

  return (
    <div {...brushScopeProps} className="contents">
      <SectionCard accent="power" title={`Power draw, ${span}`} hiddenTitle>
        <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
          <StatList
            hero={{ label: "System", value: formatWatts(system) }}
            items={
              components
                ? COMPONENTS.map((c) => ({
                    label: c.label,
                    value: formatWatts(v[c.metric]),
                  }))
                : rails.map((k) => ({
                    label: railName(k),
                    value: formatWatts(v[k]),
                  }))
            }
          />
          <RangeTotalsStrip
            windowMs={windowMs}
            totals={POWER_HERO.totals}
            testId="power-range-totals"
          />
        </div>
        <div className="flex flex-col gap-2.5">
          <Legend items={legend} />
          <ModuleHistoryChart
            chart={chart}
            lines={chartSeries(
              POWER_HERO.lines(series.values),
              apps,
              focus.seriesStyle
            )}
            yAxis={POWER_HERO.yAxis}
            accent="power"
            height={HEIGHT}
            subject={POWER_HERO.subject}
            now={figures(system, apps)}
            annotations={annotations}
          />
        </div>
        <div className="flex flex-col gap-1">
          <AppsNote lines={lines} />
          {cpuNote && <InlineMessage tone="note">{cpuNote}</InlineMessage>}
        </div>
      </SectionCard>
    </div>
  );
}

/**
 * System first as the emphasized line; apps as bare lines. App lines run
 * under the system line, so the system area fill is dropped while they are
 * drawn: inside a step-1 fill the lighter ramp steps can't be told apart.
 */
function chartSeries(
  system: StreamAreaProps["series"],
  apps: readonly AppLine[],
  style: SeriesFocus["seriesStyle"]
): StreamAreaProps["series"] {
  return [
    ...system.map((line) => ({ ...line, fill: apps.length === 0 })),
    ...apps.map((a, i) => ({
      key: `app:${a.name}`,
      values: a.values,
      step: appStyle(i).step,
      dash: appStyle(i).dashed,
      fill: false,
      edges: false,
      ...style(a.name),
    })),
  ];
}

/** The accessible name's figures: "now 14.2 W. Top apps by energy: Xcode 3.1 W". */
function figures(system: number | null, apps: readonly AppLine[]): string {
  const top =
    apps.length > 0
      ? `. Top apps by energy: ${apps.map((a) => `${a.name} ${formatWattsFine(a.avg)}`).join(", ")}`
      : "";
  return `now ${formatWatts(system)}${top}`;
}

/** What the app lines are, or why there are none. */
function AppsNote({ lines }: { lines: AppLines }) {
  const messages: Partial<
    Record<AppLines["kind"], [tone: "note" | "status" | "error", text: string]>
  > = {
    long_range: [
      "note",
      "App power lines are available for ranges up to 1 hour.",
    ],
    ok: [
      "note",
      "App lines are CPU energy as macOS estimates it, for your own processes, so they add up to less than system draw.",
    ],
    empty: [
      "status",
      "Per-app power appears after StatGlass has sampled processes for a while.",
    ],
    remote: ["note", "Per-app power isn't available for remote hosts."],
    error: ["error", "Couldn't load per-app power."],
  };
  const message = messages[lines.kind];
  return (
    message && <InlineMessage tone={message[0]}>{message[1]}</InlineMessage>
  );
}

/**
 * Package and ANE spikes (D-083) as markers; the chart drops the ones that
 * have scrolled out of its window.
 */
function useSpikeAnnotations(windowMs: number) {
  const end = useModuleEnd();
  const events = useEvents(windowMs, end);
  return useMemo(
    () =>
      events
        .filter((e) => e.detail.kind === "power_spike")
        .map((e) => ({ tsMs: e.start_ms, label: eventLabel(e) })),
    [events]
  );
}
