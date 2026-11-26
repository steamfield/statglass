/**
 * The History panel's storage meter: what is on disk now, what the chosen
 * retention grows or trims to, and the size limit as the end of the track.
 * The figures come from `meterFigures`, a plain function of the two reads and
 * the settings; the component only draws them.
 */
import { formatBytes, MISSING } from "@core/format";
import type { Settings } from "@core/generated/types";
import {
  approxSize,
  type RetentionProjection,
  sizeLimitLabel,
} from "@core/history-projection";
import { rampBackground } from "~/widgets/lib/accent";
import {
  useHistorySize,
  useRetentionProjection,
} from "../_hooks/use-history-size";

const BYTES_PER_MB = 1e6;
// A few pixels of fill on a 700 px track, so a small store still shows.
const MIN_WIDTH_PCT = 0.6;
const DISK_SOLID = rampBackground(1, "var(--color-disk)");
const DISK_HATCH = rampBackground("hatch", "var(--color-disk)");
const DISK_FADED = rampBackground(3, "var(--color-disk)");

/**
 * One bar on the track, drawn from the left edge. The meter stacks two: the
 * wider one behind, the narrower solid one in front.
 */
interface MeterBar {
  pct: number;
  background: string;
}

/** Everything the meter prints and draws; a null bar draws nothing. */
interface MeterFigures {
  size: string;
  limit: string;
  legend: { swatch: string; text: string };
  ariaLabel: string;
  back: MeterBar | null;
  front: MeterBar | null;
}

/** `bytes` as a percent of `limitBytes`, between the minimum and 100. */
function widthPct(bytes: number, limitBytes: number): number {
  return Math.min(100, Math.max(MIN_WIDTH_PCT, (bytes / limitBytes) * 100));
}

/** "once 30 days are kept", or "once the limit is reached". */
function untilText(projection: RetentionProjection, days: number): string {
  return projection.limitedDays === null
    ? `once ${days} days are kept`
    : "once the limit is reached";
}

/**
 * The bars for what is known. Growing, the projection is hatched behind the
 * recorded fill. Trimming, the fill stops at the projection and the part that
 * goes is faded behind it.
 */
function meterBars(
  sizeBytes: number | null,
  projectionBytes: number | null,
  limitBytes: number,
  trimming: boolean
): Pick<MeterFigures, "back" | "front"> {
  // Nothing recorded draws nothing; the minimum width is for small stores.
  const bar = (bytes: number | null, background: string) =>
    bytes === null || bytes <= 0
      ? null
      : { pct: widthPct(bytes, limitBytes), background };
  if (trimming) {
    return {
      back: bar(sizeBytes, DISK_FADED),
      front: bar(projectionBytes, DISK_SOLID),
    };
  }
  return {
    back: bar(projectionBytes, DISK_HATCH),
    front: bar(sizeBytes, DISK_SOLID),
  };
}

/**
 * The meter's figures. `sizeBytes` is null while its read is pending or
 * failed, `projection` while the growth read is pending; their figures show
 * `MISSING` with no bar.
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
  const days = history.retention_days;
  const trimming =
    sizeBytes !== null && projection !== null && projection.bytes < sizeBytes;
  const projected =
    projection === null ? MISSING : approxSize(projection.bytes);
  const until =
    projection === null
      ? `once ${days} days are kept`
      : untilText(projection, days);
  return {
    size,
    limit,
    legend: trimming
      ? { swatch: DISK_FADED, text: `Trimmed to about ${projected} ${until}` }
      : { swatch: DISK_HATCH, text: `About ${projected} ${until}` },
    ariaLabel: meterLabel(size, projected, until, limit, trimming, {
      size: sizeBytes !== null,
      projection: projection !== null,
    }),
    ...meterBars(sizeBytes, projection?.bytes ?? null, limitBytes, trimming),
  };
}

/**
 * What the meter says aloud, from only the figures that are known: no
 * direction without both reads, no placeholder glyph read out.
 */
function meterLabel(
  size: string,
  projected: string,
  until: string,
  limit: string,
  trimming: boolean,
  known: { size: boolean; projection: boolean }
): string {
  if (known.size && known.projection) {
    return `${size} used, ${trimming ? "trimming" : "growing"} to about ${projected} of a ${limit} limit`;
  }
  if (known.size) return `${size} used of a ${limit} limit`;
  if (known.projection) {
    return `Size on disk unavailable, about ${projected} ${until}, ${limit} limit`;
  }
  return `Size on disk unavailable, ${limit} limit`;
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

/** One bar on the track; its width eases when a figure changes. */
function TrackBar({ bar }: { bar: MeterBar | null }) {
  if (bar === null) return null;
  return (
    <div
      className="absolute inset-y-0 left-0 rounded-chip motion-safe:transition-[width] motion-safe:duration-(--motion-fast) motion-safe:ease-(--ease-out)"
      style={{ width: `${bar.pct}%`, background: bar.background }}
    />
  );
}

/** The storage meter at the top of the History panel. */
export function HistoryMeter({ history }: { history: Settings["history"] }) {
  const size = useHistorySize();
  const project = useRetentionProjection(history);
  const figures = meterFigures({
    sizeBytes: size.data ?? null,
    projection: project(history.retention_days),
    history,
  });
  return (
    // Shares Keep history's projection, so search shows it with that row.
    <div
      data-settings-part="keep-history"
      className="flex flex-col gap-2.5 border-border-subtle border-b px-4 pt-3.5 pb-3"
    >
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
        <TrackBar bar={figures.back} />
        <TrackBar bar={figures.front} />
      </div>
      <div className="flex flex-wrap gap-4 font-normal text-label text-muted-foreground">
        <LegendItem swatch={DISK_SOLID} text="Recorded so far" />
        <LegendItem swatch={figures.legend.swatch} text={figures.legend.text} />
      </div>
    </div>
  );
}
