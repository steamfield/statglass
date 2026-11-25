import { useOptionalPhoneTransport } from "@/data/transport-context";
import { FirstLaunchRedirect } from "@/hosts/first-launch-redirect";
import { HostSettings } from "@/settings/host-settings";

/** Opens the phone's host settings after a transport has been chosen. */
export default function HostsSettingsRoute() {
  const transport = useOptionalPhoneTransport();
  return transport ? <HostSettings /> : <FirstLaunchRedirect />;
}
