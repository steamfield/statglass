import type { QueryKey } from "@tanstack/react-query";

/**
 * A `placeholderData` that holds the previous answer while `next` loads, but
 * only when `same(previousKey, next)` says it is the same identity (the
 * `same*` predicates in `@core/query-keys`, which all check the host). Any
 * other key change shows nothing rather than another host's or series' data.
 */
export function holdWhile(
  next: QueryKey,
  same: (previous: QueryKey, next: QueryKey) => boolean
) {
  return <T>(
    previous: T | undefined,
    query: { queryKey: QueryKey } | undefined
  ): T | undefined =>
    query !== undefined && same(query.queryKey, next) ? previous : undefined;
}
