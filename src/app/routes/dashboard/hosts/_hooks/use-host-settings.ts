import { commandErrorText } from "@core/command-error";
import type { CommandError, RemoteHostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import { sshEndpointError } from "@core/remote-errors";
import { MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useTransport } from "~/lib/transport-context";
import type { RemoveChoices } from "../_components/remove-host-options";

export function useHostSettings(remote: RemoteHostRecord, close: () => void) {
  const transport = useTransport();
  const [config, setConfig] = useState(remote.config);
  const size = useQuery({
    queryKey: hostKeys.historySize(remote.config.id),
    queryFn: () => unwrap(transport.historySize(remote.config.id)),
    refetchInterval: MINUTE_MS,
  });
  const linux = remote.os === "linux";
  const [choices, setChoices] = useState<RemoveChoices>({
    stopSharing: true,
    uninstallAgent: true,
    purgeAgent: false,
    deleteMirror: false,
  });
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | string | null>(null);
  const endpointError =
    sshEndpointError(config.lan ?? "") ??
    sshEndpointError(config.tailscale ?? "");
  const validBudget =
    Number.isInteger(config.mirror_budget_mb) &&
    config.mirror_budget_mb >= 10 &&
    config.mirror_budget_mb <= 10000;
  const run = useSettingsCommand(
    remote,
    config,
    choices,
    close,
    setBusy,
    setError
  );
  const named =
    config.name.trim() !== "" &&
    Boolean(config.lan?.trim() || config.tailscale?.trim());
  return {
    config,
    setConfig,
    size,
    linux,
    choices,
    setChoices,
    removing,
    setRemoving,
    busy,
    error,
    endpointError,
    validBudget,
    named,
    run,
  };
}
function useSettingsCommand(
  remote: RemoteHostRecord,
  config: RemoteHostRecord["config"],
  choices: RemoveChoices,
  close: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: CommandError | string | null) => void
) {
  const transport = useTransport();
  const cache = useQueryClient();
  const linux = remote.os === "linux";
  const run = async (remove: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = remove
        ? await transport.removeRemoteHost(
            config.id,
            choices.deleteMirror,
            !linux && choices.stopSharing,
            linux && choices.uninstallAgent,
            linux && choices.uninstallAgent && choices.purgeAgent
          )
        : await transport.updateRemoteHost(config);
      if (result.status === "error") setError(result.error);
      else {
        if (remove && typeof result.data === "string") toast.error(result.data);
        await cache.invalidateQueries({ queryKey: hostKeys.all });
        close();
      }
    } catch (e) {
      console.error("[remote settings] update failed", {
        hostId: config.id,
        remove,
        error: e,
      });
      setError(commandErrorText(e, "Please try again."));
    } finally {
      setBusy(false);
    }
  };
  return run;
}
