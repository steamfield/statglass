import {
  chartRangeLabel,
  RANGE_PRESETS,
  relativeWindow,
} from "@core/chart-range";
import type { ChartWindow } from "@core/generated/bindings";
import { windowAllowed } from "@core/live-window";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "~/components/segmented-control";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { CustomRangeForm } from "~/components/window-control-custom";
import { useChartWindow } from "~/hooks/use-chart-window";
import { useGridInterval } from "~/hooks/use-grid-interval";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { cn } from "~/lib/utils";

/** Shared module range picker: two shortcuts and retained/custom ranges. */
export function WindowControl({
  onApply,
}: {
  onApply?: (value: ChartWindow) => void;
}) {
  const intervalMs = useGridInterval();
  const current = useChartWindow();
  const navigation = useRangeNavigation();
  const [open, setOpen] = useState(false);
  if (current === null) return null;
  const quick =
    current.endMs === null &&
    [5 * MINUTE_MS, HOUR_MS].includes(current.windowMs);
  const apply = (value: ChartWindow) => {
    void (onApply ?? navigation.apply)(value);
    setOpen(false);
  };
  return (
    <div className="flex items-center gap-1.5">
      <SegmentedControl
        options={[
          {
            value: "5m",
            label: "5m",
            disabled: !windowAllowed(5 * MINUTE_MS, intervalMs),
          },
          { value: "1h", label: "1h" },
        ]}
        value={typeof current.window === "string" ? current.window : ""}
        onChange={(value) => apply(value as ChartWindow)}
        ariaLabel="Window"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Time range: ${chartRangeLabel(current.window)}`}
            className={cn(
              "figures inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              !quick && "bg-primary/14 text-cpu-2-ink"
            )}
          >
            {quick ? "More" : chartRangeLabel(current.window)}
            <ChevronDown aria-hidden className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          collisionPadding={12}
          aria-label="Choose time range"
          className="w-96 max-w-[calc(100vw-24px)]"
        >
          <fieldset
            className="grid grid-cols-2 gap-x-2 gap-y-0.5"
            aria-label="Preset time ranges"
          >
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset.ms}
                type="button"
                disabled={!windowAllowed(preset.ms, intervalMs)}
                aria-pressed={
                  current.endMs === null && current.windowMs === preset.ms
                }
                onClick={() => apply(relativeWindow(preset.ms))}
                className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 aria-pressed:bg-primary/14 aria-pressed:text-cpu-2-ink"
              >
                {preset.label}
                {current.endMs === null && current.windowMs === preset.ms && (
                  <Check className="size-3" aria-hidden />
                )}
              </button>
            ))}
          </fieldset>
          <div className="mt-3 border-t pt-3">
            <CustomRangeForm
              value={current.window}
              intervalMs={intervalMs}
              onApply={apply}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
