import { errorTone } from "@core/command-error";
import type { ReactNode } from "react";
import { InlineMessage } from "./inline-message";

/**
 * The line a query shows beside its data, in a fixed order: pending, then
 * failed, then empty. A failure shows even while earlier data is held, so a
 * failed refetch stays visible; its tone follows the error kind
 * (`errorTone`). With data and no failure it renders nothing, and the owner
 * renders the data beside it.
 */
export function QueryNotice({
  query,
  loading,
  error,
  empty,
  className,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null };
  loading: ReactNode;
  /** The failure line; a function gets the query's error to word it. */
  error: ReactNode | ((error: Error) => ReactNode);
  /** Shown once the query succeeded; pass it only when the data is empty. */
  empty?: ReactNode;
  className?: string;
}) {
  if (query.isPending)
    return (
      <InlineMessage tone="status" className={className}>
        {loading}
      </InlineMessage>
    );
  if (query.isError && query.error)
    return (
      <InlineMessage tone={errorTone(query.error)} className={className}>
        {typeof error === "function" ? error(query.error) : error}
      </InlineMessage>
    );
  return empty ? (
    <InlineMessage tone="status" className={className}>
      {empty}
    </InlineMessage>
  ) : null;
}
