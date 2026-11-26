/**
 * The History tab's reads of how big this Mac's history is: the bytes on disk
 * now (refreshed every minute while shown), and what a retention choice grows
 * to from the growth this Mac measured. One query each, shared by every panel,
 * so the meter and Keep history always show the same projection.
 */
import type { Settings } from "@core/generated/types";
import {
  DEFAULT_SERIES,
  type RetentionProjection,
  retentionProjection,
} from "@core/history-projection";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { MINUTE_POLL_MS } from "~/lib/queries/timing";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";
import { useSeriesCount } from "~/stores/live-selectors";

const BYTES_PER_MB = 1e6;

/** Bytes of history on disk for the current host, polled every minute. */
export function useHistorySize() {
  const transport = useTransport();
  const hostId = useHostId();
  return useQuery({
    queryKey: hostKeys.historySize(hostId),
    queryFn: () => unwrap(transport.historySize(hostId)),
    refetchInterval: MINUTE_POLL_MS,
  });
}

/**
 * The projection for a retention choice under the current size limit, or
 * null while this Mac's measured growth loads.
 */
export function useRetentionProjection(
  history: Settings["history"]
): (days: number) => RetentionProjection | null {
  const transport = useTransport();
  const hostId = useHostId();
  const series = useSeriesCount() ?? DEFAULT_SERIES;
  // Measured on this Mac; before an hour is recorded (null) or when the read
  // fails, the fill-test model. No figure while it loads, so the fill test's
  // never flashes first.
  const growth = useQuery({
    queryKey: hostKeys.historyGrowth(hostId),
    queryFn: () => unwrap(transport.historyGrowth(hostId)),
  });
  const limitBytes = history.size_limit_mb * BYTES_PER_MB;
  return (days) =>
    growth.isPending
      ? null
      : retentionProjection(days, limitBytes, series, growth.data);
}
