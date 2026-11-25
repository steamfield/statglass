import type { SpaceHighlights } from "@core/generated/types";
import { MINUTE_MS } from "@core/time-grid";
import { InlineMessage } from "~/components/inline-message";
import { LargestFolderList } from "~/components/largest-folders";
import { SectionCard } from "~/components/section-card";
import { Button } from "~/components/ui/button";
import { useRevealHighlight } from "~/hooks/use-disk-space";
import { useNow } from "~/hooks/use-now";
import { agoLabel } from "~/lib/time-ago";

export function SpaceLastScan({
  summary,
  busy,
  onScan,
}: {
  summary: SpaceHighlights;
  busy: boolean;
  onScan: () => void;
}) {
  const now = useNow(MINUTE_MS);
  const reveal = useRevealHighlight();

  return (
    <SectionCard
      accent="disk"
      origin="tr"
      variant="default"
      title="Largest folders"
      headerAlign="center"
      aside={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="figures text-label text-muted-foreground">
            Scanned {agoLabel(now, summary.finished_ms)}
          </span>
          <Button size="sm" disabled={busy} onClick={onScan}>
            Scan again
          </Button>
        </div>
      }
    >
      <p className="text-muted-foreground text-small">
        From the last scan of {summary.volume}. Scanning again rebuilds the full
        breakdown.
      </p>
      <LargestFolderList
        folders={summary.folders}
        home={summary.home}
        onReveal={reveal.reveal}
      />
      {reveal.error && (
        <InlineMessage tone="error">{reveal.error}</InlineMessage>
      )}
    </SectionCard>
  );
}
