import { MINUTE_MS } from "../time-grid";
import type { PhoneQueries, Transport } from "../transport";

export function createMockHostHistory(
  _queries: Pick<Transport, "queryHistory" | "queryEvents">
): PhoneQueries["hostHistory"] {
  return async (request) => ({
    status: "ok",
    data: {
      tier: "m1",
      bucket_ms: MINUTE_MS,
      complete_to_ms: request.from_ms,
      series: [],
      gaps: [],
      events: [],
      stats: [],
      clamped: [],
    },
  });
}
