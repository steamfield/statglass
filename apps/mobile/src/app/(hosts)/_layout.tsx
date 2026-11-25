/**
 * The hosts stack: the hosts list, a host's screen and its module pages,
 * under iOS large titles. Wiring only.
 */
import { Stack } from "expo-router";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { FirstLaunchRedirect } from "@/hosts/first-launch-redirect";
import { useNativeCoreStarting } from "@/transport";

/** Stack for the hosts list and everything opened from it. */
export default function HostsLayout() {
  const transport = useOptionalPhoneTransport();
  const starting = useNativeCoreStarting();
  if (!transport) return starting ? null : <FirstLaunchRedirect />;

  return (
    <Stack screenOptions={{ headerLargeTitle: true }}>
      <Stack.Screen name="index" options={{ title: "Hosts" }} />
      <Stack.Screen name="[host]/index" options={{ title: "" }} />
      <Stack.Screen
        name="[host]/[module]"
        options={{ title: "", headerLargeTitle: false }}
      />
    </Stack>
  );
}
