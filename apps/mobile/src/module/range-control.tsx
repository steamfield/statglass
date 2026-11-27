import { windowLabel } from "@core/live-window";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";
import type { NativeStackNavigationOptions } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";
import { PHONE_RANGES } from "@/data/chart-window";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { SegmentedControl } from "@/ui/segmented-control";
import { Sheet } from "@/ui/sheet";

const FIFTEEN_MINUTES = 15 * MINUTE_MS;
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
  const quickRange = value === FIFTEEN_MINUTES || value === HOUR_MS;
  const chooseRange = (ms: number) => {
    if (ms !== value) onChange(ms);
  };
  return (
    <>
      <SegmentedControl<number | typeof MORE>
        segments={[
          { value: FIFTEEN_MINUTES, label: "15m" },
          { value: HOUR_MS, label: "1h" },
          { value: MORE, label: quickRange ? "More" : windowLabel(value) },
        ]}
        value={quickRange ? value : MORE}
        onChange={(next) => (next === MORE ? setOpen(true) : chooseRange(next))}
        accessibilityLabel="History range"
        compact
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
                  chooseRange(ms);
                }}
              />
            ))}
          </GroupedList>
        </ScrollView>
      </Sheet>
    </>
  );
}

/** Places the shared range control in the native header's trailing position. */
export function rangeHeaderOptions(
  value: number,
  onChange: (ms: number) => void
): Pick<
  NativeStackNavigationOptions,
  "headerRight" | "unstable_headerRightItems"
> {
  const headerRight = () => <RangeControl value={value} onChange={onChange} />;
  return {
    headerRight,
    unstable_headerRightItems: () => [
      {
        type: "custom",
        hidesSharedBackground: true,
        element: headerRight(),
      },
    ],
  };
}
