/**
 * The production query defaults as a screen sees them: a failed read is
 * retried once, a failed write is not retried.
 */
import { expect, test } from "@jest/globals";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { renderWithProviders } from "./render";

function ReadStatus({ read }: { read: () => Promise<string> }) {
  // retryDelay 0 skips TanStack's 1 s backoff; the retry count stays the app's.
  const query = useQuery({
    queryKey: ["status"],
    queryFn: read,
    retryDelay: 0,
  });
  return <Text>{query.isError ? "read failed" : "reading"}</Text>;
}

function WriteStatus({ write }: { write: () => Promise<string> }) {
  const mutation = useMutation({ mutationFn: write });
  return (
    <Text onPress={() => mutation.mutate()}>
      {mutation.isError ? "write failed" : "idle"}
    </Text>
  );
}

test("retries a failed read once, then shows the error", async () => {
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    throw new Error("host unreachable");
  };

  await renderWithProviders(<ReadStatus read={read} />);

  expect(await screen.findByText("read failed")).toBeOnTheScreen();
  expect(attempts).toBe(2);
});

test("does not retry a failed write", async () => {
  let attempts = 0;
  const write = async () => {
    attempts += 1;
    throw new Error("host refused");
  };

  await renderWithProviders(<WriteStatus write={write} />);
  await fireEvent.press(screen.getByText("idle"));

  expect(await screen.findByText("write failed")).toBeOnTheScreen();
  await waitFor(() => expect(attempts).toBe(1));
});
