/**
 * State and command wiring behind the Containers engine gate: which focal state
 * the engine is in, whether the reader chose saved history instead, and the
 * command that opens a runtime app.
 */
import type { DockerRuntimeKind, DockerSnapshot } from "@core/generated/types";
import { useCallback, useEffect, useState } from "react";
import { useTransport } from "~/lib/transport-context";
import { engineStateView } from "../_lib/engine-state";

/**
 * The engine's focal state for this snapshot, and whether the reader chose to see
 * saved history behind it. The choice resets once the engine is reachable again.
 */
export function useEngineState(snapshot: DockerSnapshot, nowMs: number) {
  const view = engineStateView(snapshot, nowMs);
  const [showingHistory, setShowingHistory] = useState(false);
  const unreachable = view !== null;
  useEffect(() => {
    if (!unreachable) setShowingHistory(false);
  }, [unreachable]);
  return { view, showingHistory, setShowingHistory };
}

/** Opens a runtime app and publishes the snapshot Rust returns; rejects with the command error. */
export function useLaunchRuntime(
  setSnapshot: (snapshot: DockerSnapshot) => void
) {
  const transport = useTransport();
  return useCallback(
    async (kind: DockerRuntimeKind) => {
      const result = await transport.dockerLaunchRuntime(kind);
      if (result.status === "error") throw result.error;
      setSnapshot(result.data);
    },
    [transport, setSnapshot]
  );
}
