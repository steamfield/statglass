/**
 * The Containers page's focal state card for an unreachable Docker engine: the
 * view's copy in an `ErrorStateCard`, the one action that fixes it, the retry
 * countdown and a way into saved history. The route owns the commands; this
 * component owns only the pending and failure state of the click.
 */
import { commandErrorText } from "@core/command-error";
import { formatDateTime } from "@core/format";
import type { DockerRuntimeKind } from "@core/generated/bindings";
import { AppWindow, Check, Copy, History, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ErrorStateCard } from "~/components/error-state-card";
import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useSecondsUntil } from "~/hooks/use-seconds-until";
import type { EngineAction, EngineStateView } from "../_lib/engine-state";

/** Callbacks the route wires to its commands. `onLaunch` rejects when the app couldn't open. */
export interface DockerEngineStateProps {
  readonly view: EngineStateView;
  readonly onLaunch: (kind: DockerRuntimeKind) => Promise<void>;
  readonly onRetry: () => void;
  readonly onChoose: () => void;
  readonly onShowHistory: () => void;
}

/** Shows why the engine can't be reached and what to do about it, in place of the page content. */
export function DockerEngineState({
  view,
  onLaunch,
  onRetry,
  onChoose,
  onShowHistory,
}: DockerEngineStateProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const actions = (
    <>
      {view.action && (
        <PrimaryAction
          action={view.action}
          runtimeName={view.runtimeName}
          onLaunch={onLaunch}
          onRetry={onRetry}
          onChoose={onChoose}
          onError={setActionError}
        />
      )}
      {view.showRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RefreshCw aria-hidden className="size-3.5" />
          Retry now
        </Button>
      )}
      {view.lastReadingMs !== null && (
        <Button size="sm" variant="outline" onClick={onShowHistory}>
          <History aria-hidden className="size-3.5" />
          View saved history
        </Button>
      )}
    </>
  );
  return (
    <ErrorStateCard
      variant="focal"
      tone={view.tone}
      title={view.title}
      summary={view.summary}
      meta={<EngineMeta view={view} />}
      gifTheme={view.gifTheme}
      gifSeed={`docker:${view.stateKey}`}
      actions={actions}
      inlineError={actionError}
      ariaLabel="Docker engine"
    />
  );
}

/** The factual line under the title: retry countdown or launch wait, then the last reading. */
function EngineMeta({ view }: { view: EngineStateView }) {
  const seconds = useSecondsUntil(view.launching ? null : view.nextAttemptMs);
  const parts: ReactNode[] = [];
  if (view.launching) parts.push(`Waiting for ${view.runtimeName}…`);
  else if (seconds === 0) parts.push("Trying now…");
  else if (seconds !== null) parts.push(`Retrying in ${seconds} s`);
  if (view.lastReadingMs !== null)
    parts.push(`Last reading ${formatDateTime(view.lastReadingMs)}`);
  if (parts.length === 0) return null;
  return <>{parts.join(" · ")}</>;
}

interface PrimaryActionProps {
  readonly action: EngineAction;
  readonly runtimeName: string;
  readonly onLaunch: (kind: DockerRuntimeKind) => Promise<void>;
  readonly onRetry: () => void;
  readonly onChoose: () => void;
  readonly onError: (message: string | null) => void;
}

/** The one button that fixes the state, chosen by the action's kind. */
function PrimaryAction({
  action,
  runtimeName,
  onLaunch,
  onRetry,
  onChoose,
  onError,
}: PrimaryActionProps) {
  switch (action.kind) {
    case "launch":
      return (
        <LaunchButton
          runtime={action.runtime}
          label={action.label}
          runtimeName={runtimeName}
          onLaunch={onLaunch}
          onError={onError}
        />
      );
    case "copy":
      return (
        <CopyCommandButton
          command={action.command}
          label={action.label}
          onError={onError}
        />
      );
    case "choose":
      return (
        <Button size="sm" onClick={onChoose}>
          {action.label}
        </Button>
      );
    case "retry":
      return (
        <Button size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden className="size-3.5" />
          {action.label}
        </Button>
      );
  }
}

/** Opens the runtime app, reading "Opening…" until the command settles. */
function LaunchButton({
  runtime,
  label,
  runtimeName,
  onLaunch,
  onError,
}: {
  runtime: DockerRuntimeKind;
  label: string;
  runtimeName: string;
  onLaunch: (kind: DockerRuntimeKind) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const launch = async () => {
    setPending(true);
    onError(null);
    try {
      await onLaunch(runtime);
    } catch (error) {
      console.error("[docker] launch failed", { runtime, error });
      onError(commandErrorText(error, `Couldn’t open ${runtimeName}.`));
    } finally {
      setPending(false);
    }
  };
  return (
    <Button size="sm" disabled={pending} onClick={() => void launch()}>
      <AppWindow aria-hidden className="size-3.5" />
      {pending ? "Opening…" : label}
    </Button>
  );
}

/** Copies a Terminal command, reading "Copied" for a moment after it lands. */
function CopyCommandButton({
  command,
  label,
  onError,
}: {
  command: string;
  label: string;
  onError: (message: string | null) => void;
}) {
  const clipboard = useCopyToClipboard("docker-engine-state");
  const copy = async () => {
    onError(null);
    const copied = await clipboard.copy(command);
    if (!copied) onError(`Couldn’t copy. Run \`${command}\` in Terminal.`);
  };
  const copiedNow = clipboard.status === "copied";
  return (
    <Button size="sm" onClick={() => void copy()}>
      {copiedNow ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
      {copiedNow ? "Copied" : label}
    </Button>
  );
}
