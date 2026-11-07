import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** A value sets the key, a list sets every value for it, `null` deletes it. */
export type SearchParamPatch = Readonly<
  Record<string, string | readonly string[] | null>
>;

/**
 * Applies a patch to a copy of `params`. When the route pages its results
 * under `pageKey`, any patch that doesn't set the page itself returns to the
 * first page.
 */
export function patchSearchParams(
  params: URLSearchParams,
  patch: SearchParamPatch,
  pageKey?: string
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string") {
      next.set(key, value);
      continue;
    }
    next.delete(key);
    if (value !== null) for (const item of value) next.append(key, item);
  }
  if (pageKey !== undefined && !(pageKey in patch)) next.delete(pageKey);
  return next;
}

/**
 * Writes route state into the URL. Every patch replaces the history entry
 * unless it asks to `push` one, and builds on the params of the last render.
 * React Router's functional `setSearchParams` does not queue updates, so two
 * patches in one event don't compose: the second drops the first. Send one
 * patch per event, combining its keys.
 */
export function useSearchParamPatch(pageKey?: string) {
  const [, setParams] = useSearchParams();
  return useCallback(
    (patch: SearchParamPatch, { push = false }: { push?: boolean } = {}) =>
      setParams((old) => patchSearchParams(old, patch, pageKey), {
        replace: !push,
      }),
    [setParams, pageKey]
  );
}
