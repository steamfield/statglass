import { Stack, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import {
  useOptionalPhoneTransport,
  useSetPhoneTransport,
} from "@/data/transport-context";
import { UpdateFlow } from "@/handover/update-flow";
import {
  isNativeTransport,
  useNativeCore,
  useNativeCoreStarting,
} from "@/transport";
import { StartupFailurePanel } from "@/ui/startup-failure";
import { Text } from "@/ui/text";

export default function UpdateFromMac() {
  const router = useRouter();
  const transport = useOptionalPhoneTransport();
  const selectTransport = useSetPhoneTransport();
  const { core, error } = useNativeCore();
  const starting = useNativeCoreStarting();
  const native = isNativeTransport(transport) ? transport : core;

  function done(applied: boolean) {
    if (applied && native && native !== transport) {
      selectTransport(native, false);
      router.replace("/(hosts)");
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/settings/hosts");
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 px-6 pt-4 pb-safe-or-6"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: "Update from Mac" }} />
      {native ? (
        <UpdateFlow core={native} done={done} />
      ) : error ? (
        <StartupFailurePanel />
      ) : (
        <Text variant="body">
          {starting
            ? "Starting StatGlass…"
            : "Updating hosts needs the StatGlass iPhone app."}
        </Text>
      )}
    </ScrollView>
  );
}
