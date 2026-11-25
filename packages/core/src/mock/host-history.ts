import { floorTo, MINUTE_MS } from "../time-grid";
import type { PhoneQueries, Transport } from "../transport";

export function createMockHostHistory(
  _queries: Pick<Transport, "queryHistory" | "queryEvents">
): PhoneQueries["hostHistory"] {
  return async (request) => {
    const now = Date.now();
    const closedBefore = now - 1_000;
    return {
      status: "ok",
      data: {
        tier: "m1",
        bucket_ms: MINUTE_MS,
        complete_to_ms: Math.max(
          request.from_ms,
          Math.min(request.to_ms ?? now, floorTo(closedBefore, MINUTE_MS))
        ),
        series: [],
        gaps: [],
        events: [],
        stats: [],
        clamped: [],
      },
    };
  };
}
