import { formatDuration } from "@core/format";
import { useEffect, useState } from "react";
import { TruncatedText } from "~/components/truncated-text";
import { StatusDot } from "~/widgets/status-dot";
import type { HostCardModel } from "../_lib/host-card-model";

export function HostCardRr({ rr }: { rr: NonNullable<HostCardModel["rr"]> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-tile border border-border-subtle bg-muted/30 px-3 py-2 font-normal text-small">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot state="live" className="shrink-0" />
        <span className="shrink-0 text-muted-foreground">rr running</span>
        {rr.command && <TruncatedText text={rr.command} className="min-w-0" />}
        <span className="figures ml-auto shrink-0 text-fg-subtle">
          {formatDuration(Math.max(0, now + rr.clockOffsetMs - rr.startedMs))}
        </span>
      </div>
      <TruncatedText
        text={rr.detail}
        className="pl-3.5 text-label text-muted-foreground"
      />
    </div>
  );
}
