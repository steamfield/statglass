/** Loading, retry and empty states for a module's history chart. */
import { commandError, errorTone } from "@core/command-error";
import { historyReadError, type useHostHistory } from "@/data/history";
import { ModuleNotice } from "@/module/module-notice";

type Read = ReturnType<typeof useHostHistory>;

/** Show the current history query state beneath a chart. */
export function HistoryNotice({
  query,
  hostName,
  hasSamples,
  showLoading = true,
}: {
  query: Pick<
    Read,
    | "error"
    | "failureReason"
    | "isFetching"
    | "isPending"
    | "isError"
    | "isSuccess"
    | "refetch"
  >;
  hostName: string | undefined;
  hasSamples: boolean;
  showLoading?: boolean;
}) {
  const kind = commandError(query.error)?.kind;
  const retryable =
    kind === "remote_busy" ||
    kind === "remote_unreachable" ||
    kind === "internal";
  const retryingBusy =
    commandError(query.failureReason)?.kind === "remote_busy";
  if (query.isPending || (query.isFetching && (retryable || retryingBusy))) {
    return showLoading ? <ModuleNotice message="Loading history…" /> : null;
  }
  if (query.isError)
    return (
      <ModuleNotice
        message={historyReadError(query.error, hostName)}
        error={errorTone(query.error) === "error"}
        onRetry={retryable ? () => void query.refetch() : undefined}
      />
    );
  return query.isSuccess && !hasSamples ? (
    <ModuleNotice message="No samples in this range" />
  ) : null;
}
