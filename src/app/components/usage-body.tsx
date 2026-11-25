/**
 * The usage card's body once an answer is in: the coverage notes over the
 * table and the table, or what stands in for it when nothing was measured.
 */
import { formatClockSeconds, formatSpan } from "@core/format";
import type { UsageByApp } from "@core/generated/types";
import { gpuShortfall, usageCoverage } from "@core/usage-rows";
import { AppsNote, UnrecordedRange } from "~/components/app-table";
import {
  UsageGroupTable,
  type UsageGroupTableProps,
} from "~/components/usage-group-table";
import { useHostNoun } from "~/hooks/use-host-record";

/** The notes over the table, or what stands in for it when nothing was measured. */
export function UsageBody(props: UsageGroupTableProps) {
  const { data, config } = props;
  const coverage = usageCoverage(data);
  const noun = useHostNoun();
  if (coverage.kind === "waiting") {
    return <AppsNote>Waiting for the first process sample…</AppsNote>;
  }
  if (coverage.kind === "unrecorded") {
    return <Unrecorded sinceMs={coverage.sinceMs} />;
  }
  return (
    <>
      {coverage.kind === "partial" && (
        <AppsNote>
          StatGlass started counting at{" "}
          <span className="figures">
            {formatClockSeconds(coverage.sinceMs)}
          </span>
          , so these figures cover{" "}
          <span className="figures">{formatSpan(coverage.coveredMs)}</span>.
        </AppsNote>
      )}
      {coverage.kind === "gaps" && (
        <AppsNote>
          Processes were sampled for{" "}
          <span className="figures">{formatSpan(coverage.coveredMs)}</span> of{" "}
          <span className="figures">{formatSpan(coverage.spanMs)}</span> (the{" "}
          {noun} slept or sampling paused). Averages are over the sampled time.
        </AppsNote>
      )}
      {config.by === "gpu" && <GpuShortfallNote data={data} />}
      {data.other.clamped.includes(config.by) && (
        <AppsNote>
          Apps measured above the system total somewhere in this range (the two
          are sampled differently), so System and other reads low there.
        </AppsNote>
      )}
      <UsageGroupTable {...props} />
    </>
  );
}

/** GPU time measured for less of the range than processes were sampled. */
function GpuShortfallNote({ data }: { data: UsageByApp }) {
  const short = gpuShortfall(data);
  if (short === null) return null;
  return (
    <AppsNote>
      GPU time was measured for{" "}
      <span className="figures">{formatSpan(short.gpuMs)}</span> of the{" "}
      <span className="figures">{formatSpan(short.coveredMs)}</span> sampled.
      Averages are over the measured time.
    </AppsNote>
  );
}

/** A range with no process sample in it: a hatched box, as on Network. */
function Unrecorded({ sinceMs }: { sinceMs: number | null }) {
  return (
    <UnrecordedRange>
      {sinceMs === null ? (
        "No process data for this range"
      ) : (
        <>
          No process data · StatGlass started counting at{" "}
          <span className="figures">{formatClockSeconds(sinceMs)}</span>
        </>
      )}
    </UnrecordedRange>
  );
}
