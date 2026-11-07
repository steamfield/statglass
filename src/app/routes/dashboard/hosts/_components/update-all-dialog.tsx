import type { RemoteHostRecord } from "@core/generated/bindings";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { reachable, useAgentUpdate } from "./use-agent-update";

type Outcome = { id: string; result: string };

/**
 * Pushes this Mac's agent to each host in turn (the backend runs one at a
 * time). Each push restarts that host's service, so the list is confirmed
 * first; results are one list, not a toast per host (design-system.md).
 * Offline hosts are listed but not attempted. The list is fixed when the
 * dialog opens: hosts drop out of the live list as they come back updated.
 * Closing the window mid-run stops after the push in flight.
 */
export function UpdateAllDialog({
  remotes: initial,
  close,
}: {
  remotes: readonly RemoteHostRecord[];
  close: () => void;
}) {
  const agentUpdate = useAgentUpdate();
  const [remotes] = useState(initial);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async () => {
    setRunning(true);
    const done: Outcome[] = [];
    for (const remote of remotes) {
      if (!mounted.current) return;
      const id = remote.config.id;
      if (!reachable(remote)) {
        done.push({ id, result: "Offline: not updated" });
        continue;
      }
      setCurrent(id);
      const error = await agentUpdate.mutateAsync(id);
      done.push({ id, result: error ?? "Update requested" });
      if (mounted.current) setOutcomes([...done]);
    }
    setCurrent(null);
    setOutcomes(done);
    setRunning(false);
  };
  const requested = outcomes?.filter((o) => o.result === "Update requested");
  const attempted = remotes.filter(reachable).length;
  const finished = outcomes !== null && !running;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Update agents"
      description={
        finished
          ? `Requested on ${requested?.length ?? 0} of ${attempted}. Each host finishes the update on its own and reconnects.`
          : "StatGlass installs this Mac’s agent on each host below. Each host’s service restarts, so its live readings pause briefly."
      }
      itemsLabel="Hosts to update"
      items={remotes.map((remote) => {
        const outcome = outcomes?.find((o) => o.id === remote.config.id);
        return {
          key: remote.config.id,
          label: remote.config.name,
          status:
            outcome?.result ??
            (current === remote.config.id
              ? "Updating…"
              : reachable(remote)
                ? null
                : "Offline: not updated"),
          tone:
            outcome && outcome.result !== "Update requested"
              ? "error"
              : "muted",
        };
      })}
      cancelLabel={finished ? null : "Cancel"}
      confirmLabel={finished ? "Done" : running ? "Updating…" : "Update agents"}
      onConfirm={finished ? close : () => void run()}
      busy={running}
      lockWhileBusy
    />
  );
}
