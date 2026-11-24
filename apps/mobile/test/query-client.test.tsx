/**
 * The production query defaults as a screen sees them: a failed read is
 * retried once, a failed write is not retried.
 */
import { expect, test } from "@jest/globals";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { Text } from "react-native";
import { Providers } from "../src/lib/providers";
import { createQueryClient } from "../src/lib/query-client";

function ReadStatus({ read }: { read: () => Promise<string> }) {
  const query = useQuery({ queryKey: ["status"], queryFn: read });
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

/**
 * The production client with garbage collection off, so no cache timer
 * outlives the test and keeps jest's worker alive.
 */
function clientWithoutGc() {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({
    queries: { ...defaults.queries, gcTime: Number.POSITIVE_INFINITY },
    mutations: { ...defaults.mutations, gcTime: Number.POSITIVE_INFINITY },
  });
  return client;
}

test("retries a failed read once, then shows the error", async () => {
  const client = clientWithoutGc();
  // Retry 1 waits TanStack's default first backoff (1 s) before trying again.
  client.setQueryDefaults(["status"], { retryDelay: 0 });
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    throw new Error("host unreachable");
  };

  await render(
    <Providers client={client}>
      <ReadStatus read={read} />
    </Providers>
  );

  expect(await screen.findByText("read failed")).toBeOnTheScreen();
  expect(attempts).toBe(2);
});

test("does not retry a failed write", async () => {
  let attempts = 0;
  const write = async () => {
    attempts += 1;
    throw new Error("host refused");
  };

  await render(
    <Providers client={clientWithoutGc()}>
      <WriteStatus write={write} />
    </Providers>
  );
  await fireEvent.press(screen.getByText("idle"));

  expect(await screen.findByText("write failed")).toBeOnTheScreen();
  await waitFor(() => expect(attempts).toBe(1));
});
