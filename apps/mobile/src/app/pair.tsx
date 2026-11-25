import { Stack } from "expo-router";
import { PairScreen } from "@/pairing";
import { screenOptions } from "@/ui/screen-options";
import { useThemeColors } from "@/ui/theme-colors";

export default function Pair() {
  const colors = useThemeColors();
  return (
    <>
      <Stack.Screen
        options={{
          ...screenOptions(colors),
          title: "Add a host",
        }}
      />
      <PairScreen />
    </>
  );
}
