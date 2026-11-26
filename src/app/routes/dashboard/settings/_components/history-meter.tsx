/**
 * The History panel's storage meter: what is on disk now, what the chosen
 * retention grows to, and the size limit as the end of the track. The figures
 * come from `meterFigures`, a plain function of the two reads and the
 * settings; the component only draws them.
 */
import { formatBytes, MISSING } from "@core/format";
import type { Settings } from "@core/generated/types";
import {
  approxSize,
  DEFAULT_SERIES,
  type RetentionProjection,
  retentionProjection,
  sizeLimitLabel,
} from "@core/history-projection";
import { useSeriesCount } from "~/stores/live-selectors";
import { rampBackground } from "~/widgets/lib/accent";
import { useHistoryGrowth, useHistorySize } from "../_hooks/use-history-size";

const BYTES_PER_MB = 1e6;
// A few pixels of fill on a 700 px track, so a fresh store still shows.
const MIN_WIDTH_PCT = 0.6;
const DISK_HATCH = rampBackground("hatch", "var(--color-disk)");

/** Everything the meter prints and draws; null widths draw nothing. */
interface MeterFigures {
  size: string;
  limit: string;
  legend: string;
  ariaLabel: string;
  /** Recorded size as a percent of the limit, or null while unknown. */
  fillPct: number | null;
  /** Projected size as a percent of the limit, or null while unknown. */
  projectionPct: number | null;
}

/** `bytes` as a percent of `limitBytes`, kept between the minimum and 100. */
function widthPct(bytes: number, limitBytes: number): number {
  return Math.min(100, Math.max(MIN_WIDTH_PCT, (bytes / limitBytes) * 100));
}

/** "About 520 MB once 30 days are kept", or "…once the limit is reached". */
function legendText(
  projection: RetentionProjection | null,
  retentionDays: number
): string {
  if (projection === null)
    return `About ${MISSING} once ${retentionDays} days are kept`;
  const until =
    projection.limitedDays === null
      ? `${retentionDays} days are kept`
      : "the limit is reached";
  return `About ${approxSize(projection.bytes)} once ${until}`;
}

/**
 * The meter's figures. `sizeBytes` and `projection` are null while their read
 * is pending or failed, and their figures show `MISSING` with no bar.
 */
function meterFigures({
  sizeBytes,
  projection,
  history,
}: {
  sizeBytes: number | null;
  projection: RetentionProjection | null;
  history: Settings["history"];
}): MeterFigures {
  const limitBytes = history.size_limit_mb * BYTES_PER_MB;
  const size =
    sizeBytes === null
      ? MISSING
      : formatBytes(sizeBytes, { unit: "MB", decimals: 0 });
  const limit = sizeLimitLabel(history.size_limit_mb);
  const projected =
    projection === null ? MISSING : approxSize(projection.bytes);
  return {
    size,
    limit,
    legend: legendText(projection, history.retention_days),
    ariaLabel: `${size} used, growing to about ${projected} of a ${limit} limit`,
    fillPct: sizeBytes === null ? null : widthPct(sizeBytes, limitBytes),
    projectionPct:
      projection === null ? null : widthPct(projection.bytes, limitBytes),
  };
}

/**
 * The size on disk and the retention projection, each null while its read
 * is pending or failed.
 */
function useMeterReads(history: Settings["history"]) {
  const size = useHistorySize();
  const growth = useHistoryGrowth();
  const series = useSeriesCount() ?? DEFAULT_SERIES;
  const projection = growth.isSuccess
    ? retentionProjection(
        history.retention_days,
        history.size_limit_mb * BYTES_PER_MB,
        series,
        growth.data
      )
    : null;
  return { sizeBytes: size.data ?? null, projection };
}

/** One legend entry: a swatch and its text. */
function LegendItem({ swatch, text }: { swatch: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        aria-hidden
        className="h-2 w-2.5 rounded-mark border border-border-subtle"
        style={{ background: swatch }}
      />
      {text}
    </span>
  );
}

const BAR =
  "absolute inset-y-0 left-0 rounded-chip motion-safe:transition-[width] motion-safe:duration-(--motion-fast) motion-safe:ease-(--ease-out)";

/** The storage meter at the top of the History panel. */
export function HistoryMeter({ history }: { history: Settings["history"] }) {
  const figures = meterFigures({ ...useMeterReads(history), history });
  return (
    <div className="flex flex-col gap-2.5 border-border-subtle border-b px-4 pt-3.5 pb-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-figure">
          <b className="figures font-medium">{figures.size}</b> on disk now
        </span>
        <span className="figures text-muted-foreground text-small">
          {figures.limit} limit
        </span>
      </div>
      <div
        role="img"
        aria-label={figures.ariaLabel}
        className="relative h-2 rounded-chip bg-track"
      >
        {figures.projectionPct !== null && (
          <div
            className={BAR}
            style={{
              width: `${figures.projectionPct}%`,
              background: DISK_HATCH,
            }}
          />
        )}
        {figures.fillPct !== null && (
          <div
            className={`${BAR} bg-disk`}
            style={{ width: `${figures.fillPct}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-4 font-normal text-label text-muted-foreground">
        <LegendItem swatch="var(--color-disk)" text="Recorded so far" />
        <LegendItem swatch={DISK_HATCH} text={figures.legend} />
      </div>
    </div>
  );
}
