import { TruncatedText } from "~/components/truncated-text";
import { AlertChip } from "~/widgets/alert-chip";
import { StatusDot } from "~/widgets/status-dot";
import type { HostCardModel } from "../_lib/host-card-model";

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
      {model.route && (
        <>
          <span aria-hidden>·</span>
          <TruncatedText text={model.route} className="figures min-w-0" />
        </>
      )}
    </div>
  );
}
