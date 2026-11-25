/**
 * The hosts stack: the hosts list, a host's screen and its module pages,
 * under iOS large titles. Wiring only.
 */
import { Stack } from "expo-router";
import { useWindowDimensions } from "react-native";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { FirstLaunchRedirect } from "@/hosts/first-launch-redirect";
import { useNativeCoreStarting } from "@/transport";
import { screenOptions } from "@/ui/screen-options";
import { useThemeColors } from "@/ui/theme-colors";

/** Stack for the hosts list and everything opened from it. */
export default function HostsLayout() {
  const transport = useOptionalPhoneTransport();
  const starting = useNativeCoreStarting();
  const colors = useThemeColors();
  useWindowDimensions();
  if (!transport) return starting ? null : <FirstLaunchRedirect />;

  const hostHeader = screenOptions(colors, { largeTitle: true });
  return (
    <Stack screenOptions={screenOptions(colors)}>
      <Stack.Screen name="index" options={{ ...hostHeader, title: "Hosts" }} />
      <Stack.Screen
        name="[host]/index"
        options={{ ...hostHeader, title: "" }}
      />
      <Stack.Screen
        name="[host]/[module]"
        options={{ title: "", headerLargeTitle: false }}
      />
    </Stack>
  );
}
