import type { TimeRange } from "@core/brush";

/** The selected interval a disk or process link carries as `from`/`to`. */
export function readRange(params: URLSearchParams): TimeRange | null {
  const fromMs = Number(params.get("from"));
  const toMs = Number(params.get("to"));
  return params.has("from") &&
    Number.isSafeInteger(fromMs) &&
    Number.isSafeInteger(toMs) &&
    fromMs >= 0 &&
    toMs > fromMs
    ? { fromMs, toMs }
    : null;
}

/** Writes `range` into `params` in place, or clears it. */
export function writeRange(params: URLSearchParams, range: TimeRange | null) {
  if (range) {
    params.set("from", String(range.fromMs));
    params.set("to", String(range.toMs));
  } else {
    params.delete("from");
    params.delete("to");
  }
}
