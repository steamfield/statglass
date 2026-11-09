import type { CommandError } from "@core/generated/bindings";
import { remoteErrorAdvice, remoteErrorText } from "@core/remote-errors";

export function RemoteSetupError({ error }: { error: CommandError | string }) {
  const advice =
    typeof error === "string"
      ? {
          title: "StatGlass could not complete this step.",
          recovery: "Try again; your entries are still here.",
        }
      : remoteErrorAdvice(error);
  const detail = typeof error === "string" ? error : remoteErrorText(error);
  return (
    <div className="grid gap-2 text-body">
      <div role="alert" className="grid gap-1">
        <p className="text-destructive">{advice?.title ?? detail}</p>
        {advice && (
          <p className="select-text whitespace-pre-wrap break-words text-fg-subtle">
            {advice.recovery}
          </p>
        )}
      </div>
      {advice && advice.recovery !== detail && (
        <details className="text-muted-foreground text-small">
          <summary>Technical details</summary>
          <p className="select-text whitespace-pre-wrap break-words">
            {detail}
          </p>
        </details>
      )}
    </div>
  );
}
