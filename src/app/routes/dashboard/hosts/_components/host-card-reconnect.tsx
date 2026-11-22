/**
 * The panel a remote host card shows in place of its metric lanes and vitals
 * while the host isn't live: what is happening, why, when the next attempt
 * runs (or how long the one in flight may take), and the last reading.
 */
import { REMOTE_DIAL_TIMEOUT_MS } from "@core/generated/bindings";
import { useRef } from "react";
import { useSecondsUntil } from "~/hooks/use-seconds-until";
import { cn } from "~/lib/utils";
import { MeterTrack } from "~/widgets/meter-track";
import type {
  HostCardModel,
  HostCardReconnectModel,
} from "../_lib/host-card-model";

const DIAL_TIMEOUT_S = REMOTE_DIAL_TIMEOUT_MS / 1000;

/** Renders the reconnect panel for a non-live remote host card. */
export function HostCardReconnect({
  panel,
  retry,
}: {
  panel: HostCardReconnectModel;
  retry: HostCardModel["retry"];
}) {
  const warning = panel.tone === "warning";
  return (
    <section
      aria-label="Connection"
      className={cn(
        "flex min-h-40 flex-col gap-2 rounded-control border px-3 py-3",
        warning ? "border-warning/30" : "border-border-subtle"
      )}
    >
      <p
        className={cn(
          "m-0 font-semibold text-body",
          warning ? "text-warning-ink" : "text-fg-subtle"
        )}
      >
        {panel.headline}
      </p>
      <p className="m-0 font-normal text-fg-subtle text-small">{panel.cause}</p>
      <div className="mt-auto flex flex-col gap-2">
        <TimingRow panel={panel} retry={retry} warning={warning} />
        {panel.facts.length > 0 && (
          <p className="figures m-0 font-normal text-label text-muted-foreground">
            {panel.facts.join(" · ")}
          </p>
        )}
      </div>
    </section>
  );
}

function TimingRow({
  panel,
  retry,
  warning,
}: {
  panel: HostCardReconnectModel;
  retry: HostCardModel["retry"];
  warning: boolean;
}) {
  if (panel.timing === "network")
    return (
      <p className="m-0 font-normal text-label text-muted-foreground">
        Reconnects when this Mac is back online
      </p>
    );
  if (panel.timing === "none" || !retry) return null;
  const fill = warning
    ? "var(--color-warning)"
    : "var(--color-muted-foreground)";
  if (retry.dialing) return <DialingRow routes={panel.routes} fill={fill} />;
  if (retry.nextAttemptMs === null) return null;
  return <CountdownRow nextAttemptMs={retry.nextAttemptMs} fill={fill} />;
}

/**
 * This Mac's wall clock when the card first saw `key`, kept until `key`
 * changes, so a bar's span starts where the card picked it up.
 */
function useFirstSeenMs(key: number | string): number {
  const seen = useRef<{ key: number | string; atMs: number } | null>(null);
  if (seen.current?.key !== key) seen.current = { key, atMs: Date.now() };
  return seen.current.atMs;
}

/** "Next attempt in N s" with a bar that drains, one step a second, to the attempt. */
function CountdownRow({
  nextAttemptMs,
  fill,
}: {
  nextAttemptMs: number;
  fill: string;
}) {
  const sinceMs = useFirstSeenMs(nextAttemptMs);
  const seconds = useSecondsUntil(nextAttemptMs) ?? 0;
  const spanMs = Math.max(nextAttemptMs - sinceMs, 1);
  return (
    <TimingLine
      text={seconds > 0 ? `Next attempt in ${seconds} s` : "Next attempt now"}
      fraction={Math.min((seconds * 1000) / spanMs, 1)}
      fill={fill}
    />
  );
}

/** The attempt in flight, with a bar filling over the dial time limit. */
function DialingRow({ routes, fill }: { routes: string; fill: string }) {
  const startedMs = useFirstSeenMs("dialing");
  const seconds = useSecondsUntil(startedMs + REMOTE_DIAL_TIMEOUT_MS) ?? 0;
  return (
    <TimingLine
      text={`Trying ${routes} now · gives up after ${DIAL_TIMEOUT_S} s`}
      fraction={1 - seconds / DIAL_TIMEOUT_S}
      fill={fill}
    />
  );
}

function TimingLine({
  text,
  fraction,
  fill,
}: {
  text: string;
  fraction: number;
  fill: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="figures m-0 font-normal text-label text-muted-foreground">
        {text}
      </p>
      {/* Steps once a second; the per-tick token is 0 ms under Reduced Motion and Performance mode. */}
      <MeterTrack fraction={fraction} fill={fill} transition />
    </div>
  );
}
