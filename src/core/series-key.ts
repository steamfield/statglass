import type { Labels, SeriesKey } from "@core/generated/bindings";

/** The characters Rust's `Labels::canonical` escapes with a backslash. */
const ESCAPED = /[\\,={}]/g;

function escapeLabel(s: string): string {
  return s.replace(ESCAPED, "\\$&");
}

/**
 * Display form of a series key, `cpu.load{core=P0}`, the same text Rust's
 * `Display` writes: `\ , = { }` inside label names and values are escaped
 * with a backslash. Labels arrive sorted by key (bindings.ts `Labels`), so
 * equal keys always produce equal strings. Used as the map key in the live
 * store.
 */
export function seriesKeyString(key: SeriesKey): string {
  if (key.labels.length === 0) return key.metric;
  const pairs = key.labels.map(
    ([k, v]) => `${escapeLabel(k)}=${escapeLabel(v)}`
  );
  return `${key.metric}{${pairs.join(",")}}`;
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

/**
 * `(value) => sk(metric, { [name]: value })`, built once per value. For keys a
 * selector looks up on every frame (a volume, an interface, a cluster), so the
 * 1 Hz path doesn't allocate the string again. The cache holds one entry per
 * value seen, which the hardware bounds.
 */
export function keyByLabel(
  metric: string,
  name: string
): (value: string) => string {
  const cache = new Map<string, string>();
  return (value) => {
    let key = cache.get(value);
    if (key === undefined) {
      key = sk(metric, { [name]: value });
      cache.set(value, key);
    }
    return key;
  };
}

/**
 * The labels of a display-form key, the inverse of `seriesKeyString`:
 * `cpu.load{core=P0}` gives `{ core: "P0" }`, a key without labels `{}`.
 * Like Rust's `Labels::parse_canonical`, only an unescaped `,` separates
 * pairs and an unescaped `=` separates name from value; the backslash escapes
 * are removed from both.
 */
export function parseLabels(display: string): Record<string, string> {
  const out: Record<string, string> = {};
  const open = display.indexOf("{");
  if (open < 0 || !display.endsWith("}")) return out;
  const inner = display.slice(open + 1, -1);
  let name = "";
  let value: string | undefined;
  const flush = () => {
    if (name && value !== undefined) out[name] = value;
    name = "";
    value = undefined;
  };
  for (let i = 0; i < inner.length; i++) {
    let c = inner[i] ?? "";
    if (c === "\\") c = inner[++i] ?? "";
    else if (c === ",") {
      flush();
      continue;
    } else if (c === "=" && value === undefined) {
      value = "";
      continue;
    }
    if (value === undefined) name += c;
    else value += c;
  }
  flush();
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
