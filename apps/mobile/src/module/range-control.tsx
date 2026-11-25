import { windowLabel } from "@core/live-window";
import { DAY_MS } from "@core/time-grid";
import { Pressable, View } from "react-native";
import { PHONE_RANGES } from "@/data/history";
import { Text } from "@/ui/text";

export function RangeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="History range"
      className="flex-row flex-wrap gap-1 rounded-xl border border-border bg-card p-1"
    >
      {PHONE_RANGES.map(({ label, ms }) => {
        const selected = ms === value;
        return (
          <Pressable
            key={ms}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            className={`min-h-[44px] min-w-[44px] grow items-center justify-center rounded-lg px-2 py-1 ${selected ? "bg-raised" : "active:opacity-70"}`}
            onPress={() => onChange(ms)}
          >
            <Text
              {...{ role: "label" }}
              className={selected ? "font-semibold text-foreground" : ""}
            >
              {ms === DAY_MS
                ? "24 h"
                : windowLabel(ms).replace(/(\d)([hd])/, "$1 $2")}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
