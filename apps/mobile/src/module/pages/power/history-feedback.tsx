import { commandError, errorTone } from "@core/command-error";
import { historyReadError, type useHostHistory } from "@/data/history";
import { ModuleNotice } from "@/module/module-notice";

export function HistoryFeedback({
  history,
  hostName,
  hasSamples,
  showLoading = true,
}: {
  history: Pick<
    ReturnType<typeof useHostHistory>,
    | "error"
    | "failureReason"
    | "isError"
    | "isFetching"
    | "isPending"
    | "isSuccess"
    | "refetch"
  >;
  hostName: string | undefined;
  hasSamples: boolean;
  showLoading?: boolean;
}) {
  const kind = commandError(history.error)?.kind;
  const retryable =
    kind === "remote_busy" ||
    kind === "remote_unreachable" ||
    kind === "internal";
  const retryingBusy =
    commandError(history.failureReason)?.kind === "remote_busy";
  if (
    history.isPending ||
    (history.isFetching && (retryable || retryingBusy))
  ) {
    return showLoading ? <ModuleNotice message="Loading history…" /> : null;
  }
  if (history.isError) {
    return (
      <ModuleNotice
        message={historyReadError(history.error, hostName)}
        error={errorTone(history.error) === "error"}
        onRetry={retryable ? () => void history.refetch() : undefined}
      />
    );
  }
  return history.isSuccess && !hasSamples ? (
    <ModuleNotice message="No samples in this range" />
  ) : null;
}
