import type { RemoteHostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTransport } from "~/lib/transport-context";

/** Remote status and card vitals; notifications refresh the cached host list. */
export function useRemoteHosts<T = RemoteHostRecord[]>(
  select?: (hosts: RemoteHostRecord[]) => T
) {
  const transport = useTransport();
  const cache = useQueryClient();
  useEffect(
    () =>
      transport.onRemoteHostsChanged(() => {
        void cache.invalidateQueries(
          { queryKey: hostKeys.remote() },
          { cancelRefetch: false }
        );
      }),
    [transport, cache]
  );
  return useQuery({
    ...(select ? { select } : {}),
    queryKey: hostKeys.remote(),
    queryFn: () => transport.listRemoteHosts(),
    refetchInterval: transport.windowLabel() === "dashboard" ? 5000 : false,
    staleTime: 4000,
  });
}
