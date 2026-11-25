import { useRouter } from "expo-router";
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
import { ScreenScroll } from "@/ui/screen-scroll";
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
    <ScreenScroll
      className="flex-1"
      contentContainerClassName="gap-4 px-6 pt-4 pb-safe-or-6"
      keyboardShouldPersistTaps="handled"
    >
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
    </ScreenScroll>
  );
}
