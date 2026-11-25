/**
 * Text search shared by the tables: one case-insensitive substring rule
 * (`matchText`), and the process search on top of it (plan 4.14, D-099),
 * which also takes a PID or listening port that starts with the digits typed.
 */

/**
 * Whether `query` is a case-insensitive substring of any field. A blank
 * query matches everything; a missing field never matches.
 */
export function matchText(
  query: string,
  ...fields: readonly (string | null | undefined)[]
): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLocaleLowerCase().includes(q) ?? false);
}

/** What a search looks at. An app row has a name only. */
export interface ProcessQueryTarget {
  name: string;
  pid?: number;
  ports?: readonly number[] | null;
}

/** A predicate for `query`, or null when it is blank (every row matches). */
export function matchProcessQuery(
  query: string
): ((p: ProcessQueryTarget) => boolean) | null {
  const q = query.trim();
  if (!q) return null;
  const digits = /^\d+$/.test(q);
  const startsWith = (n: number) => String(n).startsWith(q);
  return (p) =>
    matchText(q, p.name) ||
    (digits &&
      ((p.pid !== undefined && startsWith(p.pid)) ||
        (p.ports ?? []).some(startsWith)));
}
