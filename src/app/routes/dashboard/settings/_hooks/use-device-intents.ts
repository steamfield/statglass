import type { DeviceIntentInfo } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useTransport } from "~/lib/transport-context";

/**
 * Device updates this Mac still owes other hosts (installs and revokes,
 * pending or failed). One query shared by the Device access rows and the
 * Access tab's count, so both poll on one 10 s interval. No retry: a failed
 * read shows in the Device access row and the count shows nothing.
 */
export function useDeviceIntents(): UseQueryResult<DeviceIntentInfo[]> {
  const transport = useTransport();
  return useQuery({
    queryKey: ["device-intents"],
    queryFn: () => unwrap(transport.deviceIntents()),
    refetchInterval: 10000,
    retry: false,
  });
}
