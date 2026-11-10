import { commandErrorText } from "@core/command-error";
import type {
  CommandError,
  RemoteHostConfig,
  RemoteHostPreparation,
  RemoteSshHostTrust,
} from "@core/generated/bindings";
import { isHostKeyError, sshEndpointError } from "@core/remote-errors";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTransport } from "~/lib/transport-context";
import {
  type SetupPhase,
  useAddHostConnection,
} from "../_hooks/use-add-host-connection";
import { AddHostFields } from "./add-host-fields";
import { AddHostFooter } from "./add-host-footer";
import { AddHostStatus } from "./add-host-status";
import { AddHostTrust } from "./add-host-trust";

export { HOST_INPUT } from "./host-input";

export function AddHostDialog({
  open,
  onOpenChange,
  reinstall,
}: {
  open: boolean;
  reinstall?: RemoteHostConfig;
  onOpenChange: (open: boolean) => void;
}) {
  const transport = useTransport();
  const [name, setName] = useState(reinstall?.name ?? "");
  const [lan, setLan] = useState(reinstall?.lan ?? "");
  const [tailscale, setTailscale] = useState(reinstall?.tailscale ?? "");
  const [showMenuBar, setShowMenuBar] = useState(true);
  const [prepared, setPrepared] = useState<RemoteHostPreparation | null>(null);
  const [trust, setTrust] = useState<RemoteSshHostTrust | null>(null);
  const [phase, setPhase] = useState<SetupPhase>("idle");
  const [hostKeyError, setHostKeyError] = useState(false);
  const [error, setError] = useState<CommandError | string | null>(null);
  const busy = phase !== "idle";
  const endpoints = {
    lan: lan.trim() || null,
    tailscale: tailscale.trim() || null,
  };
  const endpointError = sshEndpointError(lan) ?? sshEndpointError(tailscale);
  const prepare = async () => {
    if (endpointError) return;
    setHostKeyError(false);
    setPrepared(null);
    setTrust(null);
    setPhase("checking");
    setError(null);
    try {
      const result = await transport.prepareRemoteHost(
        endpoints.lan,
        endpoints.tailscale
      );
      if (result.status === "error") {
        setHostKeyError(isHostKeyError(result.error));
        setError(result.error);
      } else {
        setPrepared(result.data);
        if (!name.trim()) setName(result.data.name);
      }
    } catch (e) {
      console.error("[remote setup] operation failed", {
        phase: "prepare",
        lan,
        tailscale,
        error: e,
      });
      setError(commandErrorText(e, "Please try again."));
    } finally {
      setPhase("idle");
    }
  };
  const inspect = async (alias: string) => {
    setPhase("verifying");
    setError(null);
    setTrust(null);
    try {
      const result = await transport.inspectRemoteSshHost(alias);
      if (result.status === "error") setError(result.error);
      else {
        setError(null);
        setTrust(result.data);
      }
    } catch (e) {
      console.error("[remote setup] inspect failed", {
        lan,
        tailscale,
        error: e,
      });
      setError(commandErrorText(e, "Please try again."));
    } finally {
      setPhase("idle");
    }
  };
  const accept = async () => {
    if (!trust) return;
    setPhase("verifying");
    try {
      const result = await transport.acceptRemoteSshHost(trust.token);
      if (result.status === "error") {
        setError(result.error);
        setTrust(null);
        setHostKeyError(true);
      } else {
        setTrust(null);
        await prepare();
      }
    } catch (e) {
      console.error("[remote setup] accept failed", {
        lan,
        tailscale,
        error: e,
      });
      setTrust(null);
      setHostKeyError(true);
      setError(commandErrorText(e, "Please try again."));
    } finally {
      setPhase("idle");
    }
  };
  const { add, resetAndAdd, cancel } = useAddHostConnection({
    prepared,
    name,
    endpoints,
    showMenuBar,
    phase,
    setPhase,
    setError,
    setPrepared,
    setHostKeyError,
    onOpenChange,
    lan,
    tailscale,
    mirrorBudgetMb: reinstall?.mirror_budget_mb ?? 100,
    reinstallHostId: reinstall?.id ?? null,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100svh-2rem)] overflow-y-auto"
      >
        <DialogTitle>Add host</DialogTitle>
        <DialogDescription>
          Connect to another Mac or a Linux server through SSH. StatGlass
          prefers LAN and falls back to Tailscale when both are configured.
        </DialogDescription>
        <AddHostFields
          busy={busy}
          readOnly={reinstall !== undefined}
          name={name}
          setName={setName}
          lan={lan}
          setLan={setLan}
          tailscale={tailscale}
          setTailscale={setTailscale}
          showMenuBar={showMenuBar}
          setShowMenuBar={setShowMenuBar}
          linux={prepared?.kind === "linux"}
          setPrepared={setPrepared}
          setTrust={setTrust}
          setHostKeyError={setHostKeyError}
          setError={setError}
        />
        <AddHostStatus
          endpointError={endpointError}
          prepared={prepared}
          error={error}
          busy={busy}
          phase={phase}
        />
        <AddHostTrust
          hostKeyError={hostKeyError}
          error={error}
          prepared={prepared}
          trust={trust}
          endpoints={endpoints}
          busy={busy}
          inspect={inspect}
          accept={accept}
        />
        <AddHostFooter
          reinstall={
            reinstall !== undefined &&
            prepared !== null &&
            prepared.kind === "mac" &&
            !prepared.newer_installed
          }
          phase={phase}
          busy={busy}
          cancel={cancel}
          trust={trust}
          prepared={prepared}
          add={() => add()}
          resetAndAdd={resetAndAdd}
          endpointError={endpointError}
          endpoints={endpoints}
          prepare={prepare}
        />
      </DialogContent>
    </Dialog>
  );
}
