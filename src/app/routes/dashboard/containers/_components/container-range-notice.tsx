import { recordedDate } from "@core/chart-range";
import { InlineMessage } from "~/components/inline-message";
import { useChartWindow } from "~/hooks/use-chart-window";

export function ContainerRangeNotice() {
  const range = useChartWindow();
  if (!range || range.endMs === null) return null;
  return (
    <InlineMessage tone="status">
      History: {recordedDate(range.endMs - range.windowMs)} to{" "}
      {recordedDate(range.endMs)} ·{" "}
      {Intl.DateTimeFormat().resolvedOptions().timeZone}. Inventory and controls
      retain their labeled current or last-observed state.
    </InlineMessage>
  );
}
