import { InlineMessage } from "~/components/inline-message";
export function ChartHistoryStatus({
  loading,
  error,
}: {
  loading?: boolean | undefined;
  error?: boolean | undefined;
}) {
  if (!loading && !error) return null;
  return (
    <InlineMessage tone="status">
      {error
        ? "Couldn't load chart history. Change the range to try again."
        : "Loading chart history…"}
    </InlineMessage>
  );
}
