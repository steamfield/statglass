import { commandErrorText } from "@core/command-error";
import type { CommandError, RemoteHostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { Button } from "~/components/ui/button";
import { useTransport } from "~/lib/transport-context";
import { RemoteSetupError } from "./remote-setup-error";
import { pushable, useAgentUpdate, useAgentUpdating } from "./use-agent-update";

/** Re-pairs a host that answers with a new identity, after saying what happens to the old one. */
function RepairDialog({
  remote,
  close,
}: {
  remote: RemoteHostRecord;
  close: () => void;
}) {
  const transport = useTransport();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | string | null>(null);
  const repair = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await transport.repairRemoteHost(remote.config.id);
      if (result.status === "error") setError(result.error);
      else {
        await cache.invalidateQueries({ queryKey: hostKeys.all });
        close();
      }
    } catch (e) {
      console.error("[remote hosts] re-pair failed", {
        hostId: remote.config.id,
        error: e,
      });
      setError(commandErrorText(e, "Please try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Re-pair ${remote.config.name}?`}
      description={`The host at this address now has a different identity, as after a reinstall or a replaced machine. StatGlass adds it as a new host and keeps ${remote.config.name}’s mirrored history here as an offline host.`}
      confirmLabel={busy ? "Re-pairing…" : "Re-pair as a new host"}
      onConfirm={() => void repair()}
      busy={busy}
      lockWhileBusy
    >
      {error && <RemoteSetupError error={error} />}
    </ConfirmDialog>
  );
}

/** The host-list actions a host's status offers: an agent update, or re-pairing. */
export function HostAgentActions({
  remote,
  onError,
}: {
  remote: RemoteHostRecord;
  onError: (message: string | null) => void;
}) {
  const agentUpdate = useAgentUpdate();
  const updating = useAgentUpdating(remote.config.id);
  const [repairing, setRepairing] = useState(false);
  const update = async () => {
    onError(null);
    const error = await agentUpdate.mutateAsync(remote.config.id);
    if (error) onError(error);
    else
      toast.success(
        "Update requested. The host finishes the update independently; its settings show the result."
      );
  };
  return (
    <>
      {remote.status.identity_changed !== null && (
        <Button size="sm" variant="outline" onClick={() => setRepairing(true)}>
          Re-pair…
        </Button>
      )}
      {pushable(remote) && (
        <Button
          size="sm"
          variant="outline"
          disabled={updating}
          onClick={update}
        >
          {updating ? "Updating agent…" : "Update agent"}
        </Button>
      )}
      {repairing && (
        <RepairDialog remote={remote} close={() => setRepairing(false)} />
      )}
    </>
  );
}
