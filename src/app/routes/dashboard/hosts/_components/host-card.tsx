import type { RemoteHostRecord } from "@core/generated/bindings";
import { Settings } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { InlineMessage } from "~/components/inline-message";
import { TruncatedText } from "~/components/truncated-text";
import { Button } from "~/components/ui/button";
import type { useHostRecentHistory } from "~/hooks/use-host-recent-history";
import { AlertChip } from "~/widgets/alert-chip";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";
import { StatList } from "~/widgets/stat-list";
import type { HostCardModel } from "../_lib/host-card-model";
import { HostCardActions } from "./host-card-actions";
import { HostCardRr } from "./host-card-rr";
import { HostCardStatus } from "./host-card-status";
import { HostCardVersion } from "./host-card-version";
import { HostMetricLane } from "./host-metric-lane";

export function HostCard({
  model,
  remote,
  history,
  memoryTotal,
  origin,
  onShow,
  onSelect,
  onSettings,
}: {
  model: HostCardModel;
  remote?: RemoteHostRecord;
  history: ReturnType<typeof useHostRecentHistory>["history"];
  memoryTotal: number;
  origin: Corner;
  onShow: () => void;
  onSelect: () => void;
  onSettings?: () => void;
}) {
  const titleId = useId();
  return (
    <Card
      accent="cpu"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className={`@container flex min-w-0 flex-1 flex-col gap-3.5 px-4 py-3.5 ${model.message ? "[--g:0%]" : ""}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="min-w-0 font-semibold text-body">
            <Link
              to="/dashboard/overview"
              onClick={(event) => {
                if (
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  onSelect();
              }}
              className="block truncate rounded-control outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {model.name}
            </Link>
          </h2>
          <HostCardStatus model={model} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {model.diskWarning && (
            <AlertChip tone="warn" text={model.diskWarning} />
          )}
          {onSettings && (
            <Button
              variant="outline"
              size="icon"
              aria-label={`Settings for ${model.name}`}
              onClick={onSettings}
            >
              <Settings aria-hidden className="size-3.5" />
            </Button>
          )}
        </div>
      </header>
      <MetricLanes model={model} history={history} memoryTotal={memoryTotal} />
      <div className="grid @min-[408px]:grid-cols-4 grid-cols-2 gap-3 [&>dl]:contents">
        <StatList
          layout="grid"
          items={model.vitals}
          valueClassName="flex flex-col"
        />
      </div>
      {model.rr && <HostCardRr rr={model.rr} />}
      {model.message && (
        <InlineMessage
          tone={model.message.tone}
          className="min-w-0 [&>span]:min-w-0"
        >
          <TruncatedText text={model.message.text} />
        </InlineMessage>
      )}
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 border-border-subtle border-t pt-3 font-normal text-small">
        <dt className="text-muted-foreground">System</dt>
        <dd className="min-w-0">
          <TruncatedText
            text={model.system}
            className="figures text-fg-subtle"
          />
        </dd>
        <dt className="text-muted-foreground">StatGlass</dt>
        <dd className="min-w-0">
          <HostCardVersion version={model.version} />
        </dd>
      </dl>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-border-subtle border-t pt-3">
        <HostCardActions model={model} {...(remote ? { remote } : {})} />
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onShow}>
          View metrics
        </Button>
      </footer>
    </Card>
  );
}

function MetricLanes({
  model,
  history,
  memoryTotal,
}: {
  model: HostCardModel;
  history: ReturnType<typeof useHostRecentHistory>["history"];
  memoryTotal: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-5">
      <HostMetricLane
        label="CPU"
        value={model.cpu}
        values={history?.values["cpu.total"] ?? []}
        endMs={history?.endMs ?? 0}
        intervalMs={history?.bucketMs ?? 10000}
        yMax={100}
        gaps={history?.cpuGaps ?? []}
      />
      <HostMetricLane
        label="Memory"
        value={model.memory}
        values={history?.values["mem.used"] ?? []}
        endMs={history?.endMs ?? 0}
        intervalMs={history?.bucketMs ?? 10000}
        yMax={memoryTotal}
        gaps={history?.memoryGaps ?? []}
      />
    </div>
  );
}
