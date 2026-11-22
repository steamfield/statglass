/**
 * The status line under a host card's name: state mark, status text, the
 * automatic-retry countdown for a failing remote, then the route or last-seen text.
 */
import { retryScheduleText } from "@core/remote-connection";
import { TruncatedText } from "~/components/truncated-text";
import { useSecondsUntil } from "~/hooks/use-seconds-until";
import { AlertChip } from "~/widgets/alert-chip";
import { StatusDot } from "~/widgets/status-dot";
import type { HostCardModel } from "../_lib/host-card-model";

/** Renders a host card's one-line connection status. */
export function HostCardStatus({ model }: { model: HostCardModel }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-normal text-label text-muted-foreground">
      {model.mark === "error" || model.mark === "warn" ? (
        <AlertChip
          tone={model.mark === "error" ? "critical" : "warn"}
          text={model.status}
          iconOnly
        />
      ) : (
        <StatusDot state={model.mark} className="shrink-0" />
      )}
      <span className="shrink-0 text-fg-subtle">{model.status}</span>
      {model.retry && <RetrySchedule {...model.retry} />}
      {model.route && (
        <>
          <span aria-hidden>·</span>
          <TruncatedText text={model.route} className="figures min-w-0" />
        </>
      )}
    </div>
  );
}

/** The ticking retry phrase, kept in its own component so only it re-renders each second. */
function RetrySchedule({
  nextAttemptMs,
  dialing,
}: {
  nextAttemptMs: number | null;
  dialing: boolean;
}) {
  const seconds = useSecondsUntil(dialing ? null : nextAttemptMs);
  const text = retryScheduleText(dialing, seconds);
  if (text === null) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="figures shrink-0">{text}</span>
    </>
  );
}
