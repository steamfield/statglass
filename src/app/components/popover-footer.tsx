import { formatPercent } from "@core/format";
import { ArrowUpRight } from "lucide-react";
import { Button } from "~/components/ui/button";

export interface PopoverFooterProps {
  /** `self.cpu` 60 s average, percent; `null` until the first sample. */
  selfCpuPct: number | null;
  onOpenDashboard: () => void;
  onActivity: () => void;
}

/** Popover footer: Open dashboard CTA, Activity, StatGlass's own CPU. */
export function PopoverFooter({
  selfCpuPct,
  onOpenDashboard,
  onActivity,
}: PopoverFooterProps) {
  return (
    <footer
      data-popover-size
      className="flex items-center gap-2.5 border-border border-t pt-2.5 pr-3 pb-3 pl-4"
    >
      <Button className="h-[30px] px-3 text-small" onClick={onOpenDashboard}>
        Open dashboard
        <ArrowUpRight />
      </Button>
      <Button
        variant="outline"
        className="h-[30px] px-2.5 text-small"
        onClick={onActivity}
      >
        Activity
      </Button>
      <span className="flex-1" />
      <span className="figures whitespace-nowrap text-caption text-muted-foreground">
        statglass {formatPercent(selfCpuPct, { decimals: 1 })} cpu
      </span>
    </footer>
  );
}
