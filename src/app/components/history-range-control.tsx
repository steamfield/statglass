import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";

/**
 * The retained-history toolbar for Timeline and Containers: the range
 * picker, previous and next range (next only while not live), and Live.
 * `pending` holds the steps while a range change is loading and marks the
 * toolbar busy. The steps stay focusable (aria-disabled, clicks ignored) so a
 * keyboard user stepping with Enter keeps focus; the picker stays usable.
 */
export function HistoryRangeControl({
  picker,
  live,
  onPrevious,
  onNext,
  onLive,
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
  pending?: boolean;
  previousLabel?: string;
  nextLabel?: string;
}) {
  const hold = (action: () => void) => () => {
    if (!pending) action();
  };
  const held = {
    "aria-disabled": pending || undefined,
    className: "aria-disabled:opacity-50",
  };
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
          {...held}
          onClick={hold(onPrevious)}
        >
          <ChevronLeft />
        </Button>
        {!live && (
          <Button
            variant="outline"
            size="icon"
            aria-label={nextLabel}
            {...held}
            onClick={hold(onNext)}
          >
            <ChevronRight />
          </Button>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={live}
        {...held}
        onClick={hold(onLive)}
      >
        Live
      </Button>
    </div>
  );
}
