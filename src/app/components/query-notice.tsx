import type { ReactNode } from "react";
import { InlineMessage } from "./inline-message";

/**
 * The line a query shows before or instead of its data, in a fixed order:
 * pending, then failed, then empty. Renders nothing once there is data to
 * show, so the owner renders the data beside it.
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
      <InlineMessage tone="error" className={className}>
        {typeof error === "function" ? error(query.error) : error}
      </InlineMessage>
    );
  return empty ? (
    <InlineMessage tone="status" className={className}>
      {empty}
    </InlineMessage>
  ) : null;
}
