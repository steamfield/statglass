import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

/**
 * A DHCP lease or a VPN can change the addresses without a primary-interface
 * change. The local read is cheap (no network request), so it runs often
 * enough that a VPN toggle shows within seconds.
 */
const LOCAL_REFRESH_MS = 10_000;
/** Reads addresses while a local surface that shows them is visible. */
export function useAddresses(primary: string | null) {
  const isLocal = useIsLocalHost();
  const transport = useTransport();
  const hostId = useHostId();
  const enabled = isLocal && primary !== null;
  const addresses = useQuery({
    queryKey: hostKeys.addresses(hostId),
    queryFn: () => unwrap(transport.getHostAddresses(hostId)),
    enabled,
    refetchInterval: LOCAL_REFRESH_MS,
    refetchOnWindowFocus: "always",
  });
  const data = enabled ? addresses.data : undefined;
  const publicIp = data?.public_ip;
  return {
    lan: data?.ipv4[0] ?? data?.ipv6[0] ?? null,
    publicIp: {
      data: publicIp?.state === "known" ? publicIp.detail.ip : undefined,
      isError: publicIp?.state === "unavailable",
    },
  };
}
