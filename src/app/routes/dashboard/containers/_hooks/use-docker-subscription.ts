import type { CommandResult, Unsubscribe } from "@core/transport";
import { useEffect, useRef, useState } from "react";
import { dockerErrorMessage } from "../_lib/presentation";

/** Starts a Docker channel (`dockerSubscribe`, `dockerLogs`) delivering to `onBatch`. */
export type DockerOpen<T> = (
  onBatch: (batch: T) => void
) => Promise<{ info: CommandResult<number>; unsubscribe: Unsubscribe }>;

/**
 * One Docker channel subscription while `open` is set: a new `open` (keep
 * it memoized on what the request depends on) stops the old channel and
 * starts another. Batches arriving after the effect is gone are dropped, and
 * a subscription that resolves after it is gone is stopped at once.
 * `onBatch` may change on any render without resubscribing. Returns why the
 * subscription failed (the command's error or a rejected call), or null.
 */
export function useDockerSubscription<T>(
  open: DockerOpen<T> | null,
  onBatch: (batch: T) => void
): string | null {
  const [error, setError] = useState<string | null>(null);
  const handler = useRef(onBatch);
  handler.current = onBatch;
  useEffect(() => {
    setError(null);
    if (!open) return;
    let cancelled = false;
    let stop: Unsubscribe | undefined;
    open((batch) => {
      if (!cancelled) handler.current(batch);
    })
      .then((subscription) => {
        if (cancelled) subscription.unsubscribe();
        else {
          stop = subscription.unsubscribe;
          if (subscription.info.status === "error")
            setError(dockerErrorMessage(subscription.info.error));
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [open]);
  return error;
}
