import type { WindowAppearance } from "@core/generated/bindings";
import { appKeys } from "@core/query-keys";
import type { Transport } from "@core/transport";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTransport } from "~/lib/transport-context";

/**
 * This window's appearance flags (`get_window_appearance`): read once, then
 * kept current by `window-appearance-changed` rather than read again. Not
 * retried (`makeQueryClient`): a failed read is final.
 */
export const windowAppearanceOptions = (transport: Transport) =>
  queryOptions({
    queryKey: appKeys.appearance,
    queryFn: () => transport.getWindowAppearance(),
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * The window's appearance flags, following the event while mounted.
 * `undefined` until the first read answers, or for good if it failed.
 */
export function useWindowAppearanceFlags(enabled = true) {
  const transport = useTransport();
  const client = useQueryClient();
  const query = useQuery({ ...windowAppearanceOptions(transport), enabled });
  useEffect(() => {
    if (!enabled) return;
    return transport.onWindowAppearanceChanged((e) =>
      client.setQueryData<WindowAppearance>(appKeys.appearance, e.appearance)
    );
  }, [client, enabled, transport]);
  useEffect(() => {
    if (query.error)
      console.error("[appearance] get_window_appearance failed", query.error);
  }, [query.error]);
  return query;
}
