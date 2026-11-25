import type { HostId, OfferedHost } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport/query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import type { NativeTransport } from "@/transport";

export type HandoverTransport = Pick<
  NativeTransport,
  "handover" | "listHosts" | "removeHost"
>;

export function useApplyHandover(core: HandoverTransport, previewId?: number) {
  const cache = useQueryClient();
  const { set } = usePhoneSettingsActions();
  return useMutation({
    mutationFn: (hosts: OfferedHost[]) =>
      unwrap(core.handover.addHandoverHosts(hosts, previewId)),
    onSuccess: (_, hosts) => {
      const ids = new Set(hosts.map((host) => host.id));
      set((settings) =>
        settings.removed.some((id) => ids.has(id))
          ? { removed: settings.removed.filter((id) => !ids.has(id)) }
          : settings
      );
      void cache.invalidateQueries({ queryKey: hostKeys.all });
    },
  });
}

export function useRemoveHandoverHost(core: HandoverTransport) {
  const cache = useQueryClient();
  const { set } = usePhoneSettingsActions();
  return useMutation({
    mutationFn: (host: HostId) => unwrap(core.removeHost(host)),
    onSuccess: (_, id) => {
      set((settings) => {
        const hostNames = { ...settings.hostNames };
        delete hostNames[id];
        return {
          hostNames,
          hostOrder: settings.hostOrder.filter((host) => host !== id),
        };
      });
      void cache.invalidateQueries({ queryKey: hostKeys.all });
    },
  });
}
