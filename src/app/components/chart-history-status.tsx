import { InlineMessage } from "~/components/inline-message";
export function ChartHistoryStatus({
  loading,
  error,
  quiet = false,
}: {
  /** The chart itself shows the loading state, so the loading line is for assistive technology only. */
  quiet?: boolean;
  loading?: boolean | undefined;
  error?: boolean | undefined;
}) {
  if (!loading && !error) return null;
  return (
    <InlineMessage
      tone="status"
      className={quiet && !error ? "sr-only" : undefined}
    >
      {error
        ? "Couldn't load chart history. Change the range to try again."
        : "Loading chart history…"}
    </InlineMessage>
  );
}
