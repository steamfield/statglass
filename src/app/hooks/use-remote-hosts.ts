import type { RemoteHostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import { focusManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTransport } from "~/lib/transport-context";

/** Remote status and card vitals, shared by every consumer in the window. */
export function useRemoteHosts<T = RemoteHostRecord[]>(
  select?: (hosts: RemoteHostRecord[]) => T
) {
  const transport = useTransport();
  return useQuery({
    ...(select ? { select } : {}),
    queryKey: hostKeys.remote(),
    queryFn: () => transport.listRemoteHosts(),
    refetchInterval: transport.windowLabel() === "dashboard" ? 5000 : false,
    staleTime: 4000,
    refetchOnWindowFocus: true,
  });
}

/** One event subscription per window, mounted by LocalHost. */
export function useRemoteHostsChanged() {
  const transport = useTransport();
  const cache = useQueryClient();
  useEffect(
    () =>
      transport.onRemoteHostsChanged(() => {
        if (!focusManager.isFocused()) return;
        void cache.invalidateQueries(
          { queryKey: hostKeys.remote() },
          { cancelRefetch: false }
        );
      }),
    [transport, cache]
  );
}
