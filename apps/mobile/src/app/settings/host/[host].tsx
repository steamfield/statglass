import { useLocalSearchParams } from "expo-router";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { FirstLaunchRedirect } from "@/hosts/first-launch-redirect";
import { HostDetailSettings } from "@/settings/host-detail-settings";

export default function HostDetailSettingsRoute() {
  const { host } = useLocalSearchParams<{ host: string }>();
  const transport = useOptionalPhoneTransport();
  return transport ? (
    <HostDetailSettings host={host} />
  ) : (
    <FirstLaunchRedirect />
  );
}
