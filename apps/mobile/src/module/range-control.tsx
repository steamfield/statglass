import { windowLabel } from "@core/live-window";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { useState } from "react";
import { ScrollView } from "react-native";
import { PHONE_RANGES } from "@/data/history";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { SegmentedControl } from "@/ui/segmented-control";
import { Sheet } from "@/ui/sheet";

const FIVE_MINUTES = 5 * MINUTE_MS;
const MORE = "more";

/** Choose the duration shared by history, statistics and events. */
export function RangeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const quickRange = value === FIVE_MINUTES || value === HOUR_MS;
  return (
    <>
      <SegmentedControl<number | typeof MORE>
        segments={[
          { value: FIVE_MINUTES, label: "5m" },
          { value: HOUR_MS, label: "1h" },
          { value: MORE, label: quickRange ? "More" : windowLabel(value) },
        ]}
        value={quickRange ? value : MORE}
        onChange={(next) => (next === MORE ? setOpen(true) : onChange(next))}
        accessibilityLabel="History range"
      />
      <Sheet visible={open} title="History range" onClose={close}>
        <ScrollView contentContainerClassName="pb-4">
          <GroupedList>
            {PHONE_RANGES.map(({ label, ms }) => (
              <ListRow
                key={ms}
                title={label}
                accessory={ms === value ? "checkmark" : "none"}
                onPress={() => {
                  close();
                  onChange(ms);
                }}
              />
            ))}
          </GroupedList>
        </ScrollView>
      </Sheet>
    </>
  );
}
