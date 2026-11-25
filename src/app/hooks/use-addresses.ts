import type { HostAddressesInfo } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import { CommandFailure } from "@core/transport";
import { focusManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

/**
 * A DHCP lease or a VPN can change the addresses without a primary-interface
 * change. Re-read the host's addresses so a route change shows within seconds.
 */
const LOCAL_REFRESH_MS = 10_000;
const PENDING_REFRESH_MS = 2_000;
const MAX_PENDING_POLLS = 5;

type AddressRead = {
  answer: HostAddressesInfo | null;
  // Includes the first pending answer, before the five fast polls.
  pendingReads: number;
};

/** Reads addresses while a surface that shows them is visible. */
export function useAddresses(primary: string | null, shown = true) {
  const transport = useTransport();
  const hostId = useHostId();
  const client = useQueryClient();
  const key = hostKeys.addresses(hostId);
  const addresses = useQuery({
    queryKey: key,
    queryFn: async (): Promise<AddressRead> => {
      const result = await transport.getHostAddresses(hostId);
      if (result.status === "error") {
        if (result.error.kind === "remote_unsupported") {
          return { answer: null, pendingReads: 0 };
        }
        throw new CommandFailure(result.error);
      }
      const answer = result.data;
      const previous = client.getQueryData<AddressRead>(key);
      return {
        answer,
        pendingReads:
          answer.public_ip.state === "pending"
            ? Math.min((previous?.pendingReads ?? 0) + 1, MAX_PENDING_POLLS + 1)
            : 0,
      };
    },
    enabled: () => shown && focusManager.isFocused(),
    // Reopening a surface can see a host upgrade before this query is evicted.
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.answer === null) return false;
      return !query.state.error &&
        data?.answer.public_ip.state === "pending" &&
        data.pendingReads <= MAX_PENDING_POLLS
        ? PENDING_REFRESH_MS
        : LOCAL_REFRESH_MS;
    },
    refetchOnWindowFocus: (query) =>
      query.state.data?.answer === null ? false : "always",
  });
  const data = shown && !addresses.isError ? addresses.data?.answer : undefined;
  const publicIp = data?.public_ip;
  return {
    iface: data?.interface ?? primary,
    linkMbps: data?.link_mbps ?? null,
    lan: data?.ipv4[0] ?? data?.ipv6[0] ?? null,
    failure: addresses.error?.message,
    publicIp: {
      data: publicIp?.state === "known" ? publicIp.detail.ip : undefined,
      isError:
        publicIp?.state === "unavailable" || publicIp?.state === "unknown",
    },
  };
}
