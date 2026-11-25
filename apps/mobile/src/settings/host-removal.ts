import type { HostId, HostRecord } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import { failureReason, remoteErrorText } from "@core/remote-errors";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { ActionSheetIOS, Alert } from "react-native";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import { usePhoneTransport } from "@/data/transport-context";
import { isNativeTransport } from "@/transport";

// Both Settings screens share the roster query and may be mounted together.
const pendingRemovals = new WeakMap<QueryClient, Set<HostId>>();

export function useHostRemoval() {
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const { set } = usePhoneSettingsActions();
  async function remove(host: HostRecord, onRemoved?: () => void) {
    const { id, display_name: name } = host;
    const pending = pendingRemovals.get(cache) ?? new Set<HostId>();
    if (pending.has(id)) return;
    pending.add(id);
    pendingRemovals.set(cache, pending);
    try {
      if (isNativeTransport(transport)) {
        const result = await transport.removeHost(id);
        if (result.status === "error") {
          Alert.alert(`Couldn’t remove ${name}`, remoteErrorText(result.error));
          return;
        }
        set((current) => {
          const hostNames = { ...current.hostNames };
          delete hostNames[id];
          return {
            hostNames,
            hostOrder: current.hostOrder.filter((host) => host !== id),
          };
        });
        cache.setQueryData<HostRecord[]>(hostKeys.list(), (current) =>
          current?.filter((host) => host.id !== id)
        );
        void cache.invalidateQueries({ queryKey: hostKeys.all });
      } else {
        set(({ removed }) => ({ removed: [...removed, id] }));
      }
    } catch (cause) {
      Alert.alert(
        `Couldn’t remove ${name}`,
        failureReason(cause, "Try again.")
      );
      return;
    } finally {
      pending.delete(id);
    }
    onRemoved?.();
  }

  function confirm(host: HostRecord, onRemoved?: () => void) {
    if (pendingRemovals.get(cache)?.has(host.id)) return;
    const name = host.display_name;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [`Remove ${name}`, "Cancel"],
        message: `This iPhone stops monitoring ${name}. Its history stays on the host.`,
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (index) => {
        if (index === 0) void remove(host, onRemoved);
      }
    );
  }

  return confirm;
}
