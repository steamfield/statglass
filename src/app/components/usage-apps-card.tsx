/**
 * The per-app usage card of the CPU, GPU, Memory, Power and Disk pages:
 * apps over the chart window or the brushed range, or the recorded apps
 * card over a fixed or long range. Its body is `usage-body`, the table
 * `usage-group-table`.
 */
import { scopeWords, type TimeRange } from "@core/brush";
import { remoteQueryText } from "@core/remote-errors";
import { memo, type ReactNode, useState } from "react";
import { AppsNote, AppsShell, UnrecordedRange } from "~/components/app-table";
import { brushScopeProps } from "~/components/brush-overlay";
import { HistoricalUsageCard } from "~/components/historical-usage-card";
import { SearchField } from "~/components/search-field";
import { SelectionChip } from "~/components/selection-chip";
import { UsageBody } from "~/components/usage-body";
import type { UsageTableConfig } from "~/components/usage-table-config";
import { useCanSignalSettled } from "~/hooks/use-edition";
import { useModuleEnd, useUsageHistorical } from "~/hooks/use-module-end";
import {
  heldFor,
  selectionScopeKey,
  useRangeScope,
} from "~/hooks/use-range-scope";
import { useUsageByApp } from "~/hooks/use-usage-by-app";

export type {
  UsageCells,
  UsageColumn,
  UsageTableConfig,
} from "~/components/usage-table-config";

interface UsageAppsCardProps {
  windowMs: number;
  config: UsageTableConfig;
}

/**
 * Fixed and long ranges use read-only source history. Live short ranges keep
 * per-app use over the chart window (D-091), or over the brushed range
 * when there is one (D-099): which apps used the resource, not what is busy
 * now (that is the Processes page). Rows are apps that sum their processes
 * and expand to list them; an app's actions target what Quit on that app
 * acts on in the live process batch, with individual processes selectable
 * too. After the apps come "Other apps" and "System and other", so additive
 * columns add up to the host's figure.
 */
export function UsageAppsCard(props: UsageAppsCardProps) {
  const historical = useUsageHistorical(props.windowMs);
  return historical ? (
    <MemoHistoricalUsageApps {...props} />
  ) : (
    <LiveUsageAppsCard {...props} />
  );
}

function HistoricalUsageApps({ windowMs, config }: UsageAppsCardProps) {
  const { range, keepPrevious } = useRangeScope(windowMs);
  if (config.by === "disk") {
    return (
      <AppsShell accent="disk" title="Disk by app">
        <UnrecordedRange>Per-app disk history isn’t recorded</UnrecordedRange>
      </AppsShell>
    );
  }
  return (
    <HistoricalUsageCard
      range={range}
      rolling={keepPrevious}
      by={config.by}
      accent={config.accent}
      title={`${config.noun} by app`}
    />
  );
}

const MemoHistoricalUsageApps = memo(HistoricalUsageApps);

function LiveUsageAppsCard({ windowMs, config }: UsageAppsCardProps) {
  const fixedEnd = useModuleEnd();
  const { selection, range, keepPrevious } = useRangeScope(windowMs);
  const q = useUsageByApp(range, config.by, { keepPrevious });
  const [query, setQuery] = useState("");
  // The App Store edition has no Quit or Force Quit (D-065), and a remote
  // host's processes are never signalled from here (D-117). Both are asked
  // for at mount; the table waits for the edition so its columns hold still.
  const canSignal = useCanSignalSettled();
  const data = heldFor(q, windowMs);
  const shown: TimeRange | null = data
    ? { fromMs: data.from_ms, toMs: data.to_ms }
    : selection;

  let body: ReactNode;
  if (q.isError) {
    body = (
      <AppsNote>
        {remoteQueryText(q.error, "use by app") ?? "Couldn't load use by app."}
      </AppsNote>
    );
  } else if (!data) {
    body = <AppsNote>Loading use by app…</AppsNote>;
  } else {
    body = (
      <MemoUsageBody
        data={data}
        config={config}
        query={query}
        canSignal={canSignal}
        selection={selection}
        scopeKey={selectionScopeKey(selection, windowMs)}
      />
    );
  }

  return (
    <div {...brushScopeProps} className="contents">
      <AppsShell
        accent={config.accent}
        title={`${config.noun} by app, ${scopeWords(selection ? (shown ?? selection) : fixedEnd === null ? null : range, windowMs)}`}
        aside={
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="App, process or PID"
              label={`Search ${config.noun} by app, process or PID`}
            />
            {selection && shown && <SelectionChip range={shown} />}
          </>
        }
      >
        {body}
      </AppsShell>
    </div>
  );
}

const MemoUsageBody = memo(UsageBody);
