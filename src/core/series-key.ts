import type { Labels, SeriesKey } from "@core/generated/bindings";

/**
 * Display form of a series key, `cpu.load{core=P0}`, the same text Rust's
 * `Display` writes. Labels arrive sorted by key (bindings.ts `Labels`), so
 * equal keys always produce equal strings. Used as the map key in the live
 * store.
 */
export function seriesKeyString(key: SeriesKey): string {
  if (key.labels.length === 0) return key.metric;
  return `${key.metric}{${key.labels.map(([k, v]) => `${k}=${v}`).join(",")}}`;
}

/** Build a key from a metric and label pairs, sorting labels by key. */
export function seriesKey(
  metric: string,
  labels: Record<string, string> = {}
): SeriesKey {
  const pairs: Labels = Object.entries(labels).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return { metric, labels: pairs };
}

/** `seriesKeyString(seriesKey(metric, labels))`. */
export function sk(metric: string, labels: Record<string, string> = {}) {
  return seriesKeyString(seriesKey(metric, labels));
}

/** A label name as the catalog allows it (lowercase ASCII, digits, `_`). */
const LABEL_NAME = /^[a-z0-9_]+=/;

/**
 * The labels of a display-form key, the inverse of `seriesKeyString`:
 * `cpu.load{core=P0}` gives `{ core: "P0" }`, a key without labels `{}`.
 * `seriesKeyString` does not escape, so a value may hold `=` or `,`; a `,`
 * starts the next label only when a label name and `=` follow it.
 */
export function parseLabels(display: string): Record<string, string> {
  const out: Record<string, string> = {};
  const open = display.indexOf("{");
  if (open < 0 || !display.endsWith("}")) return out;
  const pairs: [string, string][] = [];
  for (const part of display.slice(open + 1, -1).split(",")) {
    const last = pairs[pairs.length - 1];
    if (last && !LABEL_NAME.test(part)) {
      last[1] += `,${part}`;
      continue;
    }
    const eq = part.indexOf("=");
    if (eq > 0) pairs.push([part.slice(0, eq), part.slice(eq + 1)]);
  }
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

/** The value of label `name` on `key`, or undefined. */
export function labelOf(key: SeriesKey, name: string): string | undefined {
  return key.labels.find(([k]) => k === name)?.[1];
}

/** The `name` label of every series of `metric`, in layout order. */
export function labelValues(
  series: readonly SeriesKey[],
  metric: string,
  name: string
): string[] {
  const out: string[] = [];
  for (const s of series) {
    if (s.metric !== metric) continue;
    const v = labelOf(s, name);
    if (v !== undefined) out.push(v);
  }
  return out;
}
