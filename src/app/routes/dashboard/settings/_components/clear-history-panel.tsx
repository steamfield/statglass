/**
 * The History tab's "Clear history" panel: how much history this Mac holds
 * (refreshed every minute while shown) and a Clear button behind a confirm.
 */
import { formatBytes, MISSING } from "@core/format";
import { clearHistoryFailure } from "@core/history-state";
import { historyKeys, hostKeys } from "@core/query-keys";
import { useState } from "react";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useCommandMutation } from "~/hooks/use-command-mutation";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";
import { useHistorySize } from "../_hooks/use-history-size";

const formatMegabytes = (bytes: number) =>
  formatBytes(bytes, { unit: "MB", decimals: 0 });

/**
 * The clear_history command, refreshing history and its size after. `run`
 * settles either way: useCommandMutation logs and toasts a failure, and the
 * caller closes its dialog so the user sees that report.
 */
function useClearHistory() {
  const transport = useTransport();
  const clearing = useCommandMutation(
    (host: string) => transport.clearHistory(host),
    {
      name: "clear_history",
      errorText: clearHistoryFailure,
      invalidate: (host) => [
        historyKeys.host(host),
        hostKeys.historySize(host),
      ],
    }
  );
  return {
    run: (host: string) =>
      clearing.mutateAsync(host).then(
        () => undefined,
        () => undefined
      ),
    busy: clearing.isPending,
  };
}

/** "Clear history": the size on disk and Clear history… with its confirm dialog. */
export function ClearHistoryPanel() {
  const hostId = useHostId();
  const [confirming, setConfirming] = useState(false);
  const size = useHistorySize();
  const clearing = useClearHistory();

  const clear = async () => {
    await clearing.run(hostId);
    setConfirming(false);
  };

  const sizeText =
    size.data === undefined ? MISSING : formatMegabytes(size.data);
  return (
    <SettingsPanel id="clear-history" title="Clear history">
      <SettingsRow
        id="clear-history"
        label="Clear history"
        sub={`${sizeText} of recorded history on this Mac.`}
      >
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={size.data === 0}
          onClick={() => setConfirming(true)}
        >
          Clear history…
        </Button>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          className="sm:max-w-sm"
          title="Clear history?"
          description={
            <>
              Deletes the {sizeText} of history stored for this Mac. Live values
              keep updating, and the Timeline starts again from now. This can't
              be undone.
            </>
          }
          confirmLabel="Clear history"
          confirmVariant="destructive"
          onConfirm={clear}
          busy={clearing.busy}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}
