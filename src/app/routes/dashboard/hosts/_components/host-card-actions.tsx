import { commandErrorText } from "@core/command-error";
import type { RemoteHostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import { useTransport } from "~/lib/transport-context";
import { useAgentUpdate } from "../_hooks/use-agent-update";
import type { HostCardModel } from "../_lib/host-card-model";
import { AddHostDialog } from "./add-host-dialog";
import { RepairDialog } from "./host-agent-actions";

export function HostCardActions({
  model,
  remote,
  connectionActions = true,
}: {
  model: HostCardModel;
  remote?: RemoteHostRecord;
  connectionActions?: boolean;
}) {
  const transport = useTransport();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const update = useAgentUpdate();
  const [repairing, setRepairing] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!remote) return;
    if (model.stateAction === "Re-pair…") {
      setRepairing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (model.stateAction === "Turn on")
        await unwrap(
          transport.updateRemoteHost({ ...remote.config, enabled: true })
        );
      else await unwrap(transport.retryRemoteHost(remote.config.id));
      await cache.invalidateQueries({ queryKey: hostKeys.remote() });
    } catch (cause) {
      console.error("[hosts] connection action failed", {
        hostId: model.id,
        action: model.stateAction,
        error: cause,
      });
      setError(commandErrorText(cause, "Please try again."));
    } finally {
      setBusy(false);
    }
  };
  const requestUpdate = async () => {
    const action = model.version.action;
    if (!action) return;
    setError(null);
    if (action.kind === "settings") {
      void navigate("/dashboard/settings");
      return;
    }
    if (action.kind === "add_host") {
      setReinstalling(true);
      return;
    }
    setError(await update.mutateAsync(model.id));
  };
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {connectionActions && model.stateAction && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run()}
          >
            {model.stateAction}
          </Button>
        )}
        {model.version.progress ? (
          <Button variant="outline" size="sm" disabled>
            Updating…
          </Button>
        ) : (
          model.version.action && (
            <Button
              variant="outline"
              size="sm"
              disabled={update.isPending}
              onClick={() => void requestUpdate()}
            >
              {model.version.action.label}
            </Button>
          )
        )}
      </div>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {remote && repairing && (
        <RepairDialog remote={remote} close={() => setRepairing(false)} />
      )}
      {remote && reinstalling && (
        <AddHostDialog
          open
          onOpenChange={setReinstalling}
          reinstall={remote.config}
        />
      )}
    </>
  );
}
