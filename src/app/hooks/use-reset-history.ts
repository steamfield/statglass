import { resetHistoryFailure } from "@core/history-state";
import { historyKeys, hostKeys } from "@core/query-keys";
import { toast } from "sonner";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";
import { useCommandMutation } from "./use-command-mutation";

/**
 * `reset_history` (D-064): moves the history file aside and starts an empty
 * one. On success every history query, the size on disk and the health are
 * refetched, so the banner clears without waiting for the health event. A
 * failure is a toast; `store_busy` names the other StatGlass holding the file.
 * Resolves true when the store was reset.
 */
export function useResetHistory() {
  const transport = useTransport();
  const hostId = useHostId();
  const mutation = useCommandMutation(() => transport.resetHistory(), {
    name: "reset_history",
    errorText: resetHistoryFailure,
    invalidate: () => [
      historyKeys.all,
      hostKeys.historySize(hostId),
      hostKeys.historyHealth(hostId),
    ],
    onSuccess: () =>
      toast.success("History reset. The old file was kept aside."),
  });

  const reset = (): Promise<boolean> =>
    mutation.mutateAsync().then(
      () => true,
      () => false
    );

  return { reset, resetting: mutation.isPending };
}
