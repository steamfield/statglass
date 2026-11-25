import { commandError, errorTone } from "@core/command-error";
import { useEffect, useRef } from "react";
import { historyReadError, type useHostHistory } from "@/data/history";
import { ModuleNotice } from "@/module/module-notice";

type Read = ReturnType<typeof useHostHistory>;

/** Refresh a range picked again while its reply is still fresh in the cache. */
export function useRefreshOnRangeChange(windowMs: number, query: Read) {
  const previous = useRef(windowMs);
  const { isEnabled, isFetching, isSuccess, refetch } = query;
  useEffect(() => {
    const changed = previous.current !== windowMs;
    previous.current = windowMs;
    if (changed && isEnabled && isSuccess && !isFetching) {
      void refetch({ cancelRefetch: false });
    }
  }, [isEnabled, isFetching, isSuccess, refetch, windowMs]);
}

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
