import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";

/**
 * The retained-history toolbar for Timeline and Containers: the range
 * picker, previous and next range (next only while not live), and Live.
 * `pending` holds the steps while a range change is loading and marks the
 * toolbar busy; `disabled` holds them for any other reason. The picker
 * stays usable either way.
 */
export function HistoryRangeControl({
  picker,
  live,
  onPrevious,
  onNext,
  onLive,
  disabled = false,
  pending = false,
  previousLabel = "Previous range",
  nextLabel = "Next range",
}: {
  /** The range choice: a segmented control or the chart window menu. */
  picker: ReactNode;
  live: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onLive: () => void;
  disabled?: boolean;
  pending?: boolean;
  previousLabel?: string;
  nextLabel?: string;
}) {
  const held = disabled || pending;
  return (
    <div
      className="flex flex-wrap items-center gap-3"
      aria-busy={pending || undefined}
    >
      {picker}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          aria-label={previousLabel}
          disabled={held}
          onClick={onPrevious}
        >
          <ChevronLeft />
        </Button>
        {!live && (
          <Button
            variant="outline"
            size="icon"
            aria-label={nextLabel}
            disabled={held}
            onClick={onNext}
          >
            <ChevronRight />
          </Button>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={live}
        disabled={held}
        onClick={onLive}
      >
        Live
      </Button>
    </div>
  );
}
