/**
 * Gates the Containers page content on the Docker engine being reachable: while
 * it isn't, the engine's focal state card stands in for the content until the
 * reader asks for saved history.
 */
import type { DockerSnapshot } from "@core/generated/bindings";
import type { ReactNode } from "react";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import { useEngineState, useLaunchRuntime } from "../_hooks/use-engine-state";
import type { EngineStateView } from "../_lib/engine-state";
import { DockerEngineState } from "./docker-engine-state";

/** The snapshot to judge, the route's commands, and the content to gate. */
export interface DockerEngineGateProps {
  readonly snapshot: DockerSnapshot;
  readonly nowMs: number;
  readonly setSnapshot: (snapshot: DockerSnapshot) => void;
  readonly onRetry: () => void;
  readonly onChoose: () => void;
  readonly children: ReactNode;
}

/**
 * While the engine is unreachable, shows its focal state card in place of the
 * page content (`children`), until the reader asks for saved history.
 */
export function DockerEngineGate({
  snapshot,
  nowMs,
  setSnapshot,
  onRetry,
  onChoose,
  children,
}: DockerEngineGateProps) {
  const { view, showingHistory, setShowingHistory } = useEngineState(
    snapshot,
    nowMs
  );
  const launchRuntime = useLaunchRuntime(setSnapshot);
  if (view === null) return children;
  if (!showingHistory)
    return (
      <DockerEngineState
        view={view}
        onLaunch={launchRuntime}
        onRetry={onRetry}
        onChoose={onChoose}
        onShowHistory={() => setShowingHistory(true)}
      />
    );
  return (
    <>
      <SavedHistoryLine view={view} onBack={() => setShowingHistory(false)} />
      {children}
    </>
  );
}

/** One line above saved history saying the engine is still unreachable, with a way back. */
function SavedHistoryLine({
  view,
  onBack,
}: {
  view: EngineStateView;
  onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <InlineMessage tone="status">
        {view.title} · showing saved history
      </InlineMessage>
      <Button size="sm" variant="ghost" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
