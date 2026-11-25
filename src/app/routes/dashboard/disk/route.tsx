import { relativeWindow } from "@core/chart-range";
import { formatBytes, formatRate } from "@core/format";
import { LOW_DISK_FREE_BYTES, type SpaceVolume } from "@core/generated/types";
import { readRange, writeRange } from "@core/range-params";
import { keyByLabel, labelValues } from "@core/series-key";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { brushScopeProps, useDismissOutside } from "~/components/brush-overlay";
import { InlineMessage } from "~/components/inline-message";
import { PageHeader } from "~/components/page-header";
import { SectionCard } from "~/components/section-card";
import { SelectionSummary } from "~/components/selection-summary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { VolumeTable } from "~/components/volume-table";
import { WindowControl } from "~/components/window-control";
import { useChartWindow, useSetChartWindow } from "~/hooks/use-chart-window";
import { useDiskIo, useDiskIoScope } from "~/hooks/use-disk-io";
import { useSpaceVolumes } from "~/hooks/use-disk-space";
import { useEdition } from "~/hooks/use-edition";
import { useElementSize } from "~/hooks/use-element-size";
import { useHostNoun, useHostRecord } from "~/hooks/use-host-record";
import { useProcessColumnCaps } from "~/hooks/use-process-interest";
import { useHeld, useLayout } from "~/hooks/use-ring";
import { useSearchParamPatch } from "~/hooks/use-search-param-patch";
import { DashboardBanners, DashboardBody } from "~/lib/dashboard-shell";
import { cn } from "~/lib/utils";
import { useBrushRange, useBrushStore } from "~/stores/brush-store";
import { ChartRangeNotice, ChartRangeProvider } from "~/stores/chart-range";
import { useMemory } from "~/stores/live-selectors";
import { StatList } from "~/widgets/stat-list";
import { DiskIoCharts } from "./_components/disk-io-charts";
import { DiskProcesses } from "./_components/disk-processes";
import { DiskRangeTotals } from "./_components/disk-range-totals";
import { volumeRows } from "./_lib/disk";

/** Where the disk space report lives (D-153); `vol` opens that volume. */
const DISK_SPACE = "/dashboard/disk-space";

export default function DiskRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const edition = useEdition();
  // The report was a second view of Disk before D-153; old links still open it.
  if (params.get("view") === "space") {
    const vol = params.get("vol");
    return (
      <Navigate
        replace
        to={vol ? `${DISK_SPACE}?${new URLSearchParams({ vol })}` : DISK_SPACE}
      />
    );
  }
  return (
    <ChartRangeProvider initial={readRange(params)}>
      <DiskActivity
        onAnalyze={
          edition?.disk_space
            ? (vol) => navigate(`${DISK_SPACE}?${new URLSearchParams({ vol })}`)
            : undefined
        }
      />
    </ChartRangeProvider>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive logic; split when substantially changed (architecture refactor section 10).
function DiskActivity({
  onAnalyze,
}: {
  /** Opens Disk space for a volume; absent when this build has no report. */
  onAnalyze: ((vol: string) => void) | undefined;
}) {
  const chartWindow = useChartWindow();
  const setChartWindow = useSetChartWindow();
  const windowMs = chartWindow?.windowMs ?? null;
  const [params, setParams] = useSearchParams();
  const patch = useSearchParamPatch();
  const hostRecord = useHostRecord();
  // Rows without measured disk rates would list every process at 0 B/s.
  const diskIo = useProcessColumnCaps().diskIo;
  const chosen = params.get("device");
  const secondary = params.get("response") === "ops" ? "ops" : "time";
  const selection = useBrushRange();
  const brush = useBrushStore();
  // Keep dismissal available while changing range unmounts the loading plots.
  useDismissOutside(brush.getState().clear, selection !== null);
  // A pinned interval keeps its surrounding chart window when live time advances.
  const fixedEnd = chartWindow?.endMs ?? null;
  const {
    local,
    inventory,
    defaultDevice,
    device,
    devices,
    range,
    canReadHistory,
  } = useDiskIoScope(windowMs, fixedEnd, selection, chosen);
  const [chartRef, chartWidth] = useElementSize("width", 1000);
  const maxPoints = Math.max(
    12,
    Math.min(120, Math.floor((chartWidth - 128) / 5))
  );
  const chart = useDiskIo(
    device,
    range,
    maxPoints,
    selection === null && fixedEnd === null
  );
  const selectedTotals = useDiskIo(
    device,
    canReadHistory ? selection : null,
    1
  );
  const totals = selection
    ? selectedTotals.isError
      ? undefined
      : selectedTotals.data
    : chart.data;
  const layout = useLayout();
  const vols = useMemo(
    () => labelValues(layout?.series ?? [], "disk.total", "vol"),
    [layout]
  );
  const volKeys = useMemo(
    () =>
      ["disk.used", "disk.free", "disk.total"].flatMap(
        (m) => layout?.byMetric.get(m) ?? []
      ),
    [layout]
  );
  const held = useHeld(volKeys);
  const scanVolumes = useSpaceVolumes(onAnalyze !== undefined);
  const mounts = hostRecord?.info.boot_mounts ?? [];
  const selected = devices.find((d) => d.dev === device);
  const missing =
    device !== null && inventory.data !== undefined && selected === undefined;
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (local && chosen === null && inventory.data)
      next.set("device", inventory.data.default_device ?? "all");
    if (!local && chosen === null && defaultDevice !== null)
      next.set("device", defaultDevice);
    writeRange(next, selection);
    if (next.toString() !== params.toString())
      setParams(next, { replace: true });
  }, [
    chosen,
    inventory.data,
    local,
    params,
    defaultDevice,
    selection,
    setParams,
  ]);
  return (
    <div className="flex min-w-0 flex-col gap-4 [&_[data-slot=toggle-group-item][data-state=on]]:text-foreground">
      <PageHeader
        title="Disk"
        subtitle={
          selected
            ? `${selected.name} · ${selected.dev}${selected.internal === true ? " · Internal" : selected.internal === false ? " · External" : ""}`
            : missing
              ? `${device} · Disconnected or unavailable`
              : "All devices"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <WindowControl />
            <ChartRangeNotice />
          </div>
        }
      />
      <DashboardBanners />
      <DashboardBody>
        <div {...brushScopeProps} ref={chartRef} className="min-w-0">
          <SectionCard
            accent="disk"
            title="Disk I/O"
            compactHeader
            headerAlign="center"
            className="gap-3"
            aside={
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select
                  value={device ?? "all"}
                  onValueChange={(device) => patch({ device })}
                >
                  <SelectTrigger
                    aria-label="Disk device"
                    size="sm"
                    className="max-w-56"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All devices</SelectItem>
                    {devices.map((d) => (
                      <SelectItem key={d.dev} value={d.dev}>
                        {d.name} · {d.dev}
                      </SelectItem>
                    ))}
                    {missing && (
                      <SelectItem value={device}>
                        {device} · Unavailable
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={() => {
                    brush.getState().clear();
                    if (windowMs !== null && fixedEnd !== null)
                      setChartWindow(relativeWindow(windowMs));
                  }}
                  aria-pressed={selection === null && fixedEnd === null}
                  className="h-7 rounded-control border border-border bg-btn px-3 text-small outline-none hover:bg-selected focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Live
                </button>
              </div>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
              <CurrentRates device={device} />
              <div className="flex min-w-0 flex-col gap-1">
                <DiskRangeTotals
                  page={totals}
                  requested={selection ?? range}
                  selected={selection !== null}
                />
                {selection && selectedTotals.isError && (
                  <InlineMessage tone="status">
                    Couldn't load byte totals for the selected interval.
                  </InlineMessage>
                )}
              </div>
            </div>
            {local && inventory.isError ? (
              <InlineMessage tone="status">
                Couldn't load disk devices.
              </InlineMessage>
            ) : chart.isError ? (
              <InlineMessage tone="status">
                Couldn't load disk I/O history.
              </InlineMessage>
            ) : chart.data && range ? (
              <DiskIoCharts
                page={chart.data}
                range={range}
                fixedEndMs={
                  selection === null && fixedEnd === null ? null : range.toMs
                }
                secondary={secondary}
                onSecondary={(response) => patch({ response })}
              />
            ) : (
              <InlineMessage tone="status">Loading disk I/O…</InlineMessage>
            )}
            {device === null && (
              <p className="text-label text-muted-foreground">
                Request times are weighted by completed operations. A busy fast
                device can hide a slower device; select a drive to inspect it.
              </p>
            )}
            {missing && (
              <InlineMessage tone="status">
                This device is unavailable. Recorded history remains selected.
              </InlineMessage>
            )}
            {windowMs !== null && (
              <SelectionSummary windowMs={windowMs} inset={0} />
            )}
          </SectionCard>
        </div>
        <SectionCard
          accent="disk"
          origin="bl"
          title="Volumes"
          variant="default"
          className="overflow-hidden"
        >
          <section
            aria-label="Volume capacity"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the horizontally scrollable volume table needs keyboard access
            tabIndex={0}
            className="relative min-w-0 max-w-full overflow-x-auto rounded-chip outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <VolumeTable
              rows={volumeRows(vols, held, mounts)}
              units="GB"
              action={(row) => (
                <VolumeActions
                  freeBytes={row.freeBytes}
                  scanVolume={
                    scanVolumes.isSuccess
                      ? scanVolumes.data.find((v) => v.mount === row.id)
                      : undefined
                  }
                  onAnalyze={onAnalyze}
                />
              )}
            />
          </section>
        </SectionCard>
        {windowMs !== null && diskIo && <DiskProcesses windowMs={windowMs} />}
        <MemoryContext />
      </DashboardBody>
    </div>
  );
}
const readKey = keyByLabel("disk.read", "dev");
const writeKey = keyByLabel("disk.write", "dev");

function CurrentRates({ device }: { device: string | null }) {
  const read = device === null ? "disk.read_total" : readKey(device);
  const write = device === null ? "disk.write_total" : writeKey(device);
  const values = useHeld([read, write]);
  return (
    <StatList
      hero={{ label: "Read/s now", value: formatRate(values[read] ?? null) }}
      items={[
        { label: "Write/s now", value: formatRate(values[write] ?? null) },
      ]}
    />
  );
}
function VolumeActions({
  freeBytes,
  scanVolume,
  onAnalyze,
}: {
  freeBytes: number | null;
  scanVolume: SpaceVolume | undefined;
  onAnalyze: ((vol: string) => void) | undefined;
}) {
  const low = freeBytes !== null && freeBytes < LOW_DISK_FREE_BYTES;
  return (
    <span className="inline-flex items-center gap-1">
      {low && (
        <span className="figures inline-flex w-24 shrink-0 items-center justify-end gap-1 text-warning-ink">
          <span className="sr-only">Low disk space.</span>
          <TriangleAlert aria-hidden className="icon-regular size-3" />
          <span>{formatBytes(freeBytes).replace(".0 ", " ")} free</span>
        </span>
      )}
      {onAnalyze && scanVolume && (
        <>
          {low && <span aria-hidden> · </span>}
          <AnalyzeLink
            name={scanVolume.name}
            low={low}
            onClick={() => onAnalyze(scanVolume.mount)}
          />
        </>
      )}
    </span>
  );
}

function AnalyzeLink({
  name,
  low,
  onClick,
}: {
  name: string;
  low: boolean;
  onClick: () => void;
}) {
  const label = "See what's using space";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} on ${name}`}
      className={cn(
        "rounded-chip text-small underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        low ? "text-foreground" : "text-fg-subtle"
      )}
    >
      {label}
    </button>
  );
}

function MemoryContext() {
  const memory = useMemory();
  const noun = useHostNoun();
  if ((memory.pressureLevel ?? 0) === 0 && (memory.swapUsed ?? 0) === 0)
    return null;
  return (
    <p className="text-muted-foreground text-small">
      This {noun} is using swap or reporting memory pressure.{" "}
      <Link
        className="rounded-chip text-fg-subtle underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        to="/dashboard/memory"
      >
        Inspect Memory
      </Link>
    </p>
  );
}
