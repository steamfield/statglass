import type { CommandError, HostHistoryPage } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { appKeys, historyKeys, hostKeys } from "@core/query-keys";
import { type CommandResult, unwrap } from "@core/transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import { useModuleHistory } from "@/data/history";
import type { PhoneTransport } from "@/data/seam";
import { useSetPhoneTransport } from "@/data/transport-context";
import { createQueryClient } from "@/lib/query-client";

function SwitchTransport({ to }: { to: PhoneTransport }) {
  const setTransport = useSetPhoneTransport();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => setTransport(to, false)}
    >
      <Text>Switch transport</Text>
    </Pressable>
  );
}

test("a transport swap drops host reads and history and retains app queries", async () => {
  const transport = createMockTransport();
  const next = createMockTransport({ scenarios: ["linux"] });
  const { client } = await renderWithProviders(<SwitchTransport to={next} />, {
    transport,
  });
  const hosts = await transport.listHosts();
  const host = hosts[0]?.id ?? "demo";
  const history = historyKeys.hostHistory(
    host,
    [{ metric: "cpu.total", labels: [] }],
    1,
    2,
    30
  );
  client.setQueryData(hostKeys.list(), hosts);
  client.setQueryData(history, "old history");
  client.setQueryData(appKeys.appearance, "dark");

  await fireEvent.press(
    screen.getByRole("button", { name: "Switch transport" })
  );
  expect(client.getQueryData(hostKeys.list())).toBeUndefined();
  expect(client.getQueryData(history)).toBeUndefined();
  expect(client.getQueryData(appKeys.appearance)).toBe("dark");
});

function HistoryReadout() {
  const history = useModuleHistory(MOCK_HOST_ID, "cpu", {
    fromMs: 0,
    toMs: 120_000,
    fixed: false,
  });
  return (
    <Text>
      {history.data
        ? `History through ${history.data.complete_to_ms}`
        : "Loading history"}
    </Text>
  );
}

test("mounted history drops the last transport’s data while the next transport loads", async () => {
  const source = createMockTransport({ historyRows: 1 });
  const page = await unwrap(
    source.hostHistory({
      host: MOCK_HOST_ID,
      series: [{ metric: "cpu.total", labels: [] }],
      from_ms: 0,
      to_ms: 120_000,
      max_points: 30,
      events_for: null,
    })
  );
  const next = Promise.withResolvers<CommandResult<HostHistoryPage>>();
  await renderWithProviders(
    <>
      <HistoryReadout />
      <SwitchTransport to={{ ...source, hostHistory: () => next.promise }} />
    </>,
    { transport: source }
  );
  expect(
    await screen.findByText(`History through ${page.complete_to_ms}`)
  ).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Switch transport" })
  );
  expect(screen.getByText("Loading history")).toBeOnTheScreen();
  expect(
    screen.queryByText(`History through ${page.complete_to_ms}`)
  ).toBeNull();
  await act(() =>
    next.resolve({
      status: "ok",
      data: { ...page, complete_to_ms: 120_000 },
    })
  );
  expect(await screen.findByText("History through 120000")).toBeOnTheScreen();
});

const terminal: readonly CommandError[] = [
  { kind: "unknown_host", host: "missing" },
  { kind: "store_too_new", found: 2, supported: 1 },
  { kind: "invalid_argument", message: "Invalid host" },
];

test.each([
  { name: "plain Error", error: new Error("Read failed"), attempts: 2 },
  {
    name: "native-source",
    error: Object.assign(new Error("Phone key unavailable"), {
      source: "native",
    }),
    attempts: 1,
  },
])(
  "a $name rejection gets $attempts read attempts",
  async ({ error, attempts }) => {
    const client = createQueryClient();
    const queryFn = jest.fn(() => Promise.reject(error));
    try {
      await expect(
        client.fetchQuery({ queryKey: hostKeys.list(), queryFn, retryDelay: 0 })
      ).rejects.toBe(error);
      expect(queryFn).toHaveBeenCalledTimes(attempts);
    } finally {
      client.clear();
    }
  }
);

test.each(terminal)("a $kind read fails without retrying", async (error) => {
  const client = createQueryClient();
  const queryFn = jest.fn(() =>
    unwrap(Promise.resolve({ status: "error", error }))
  );
  try {
    await expect(
      client.fetchQuery({ queryKey: hostKeys.list(), queryFn, retryDelay: 0 })
    ).rejects.toMatchObject({ error });
    expect(queryFn).toHaveBeenCalledTimes(1);
  } finally {
    client.clear();
  }
});

test.each([
  { kind: "internal", message: "Call failed" },
  { kind: "remote_busy", message: "Host is busy" },
  { kind: "store_busy", message: "Store is busy" },
] satisfies CommandError[])(
  "a $kind read failure retries once",
  async (error) => {
    jest.useFakeTimers();
    const client = createQueryClient();
    const queryFn = jest.fn(() =>
      unwrap(Promise.resolve({ status: "error", error }))
    );
    try {
      const result = client.fetchQuery({ queryKey: hostKeys.list(), queryFn });
      const failure = expect(result).rejects.toMatchObject({ error });
      await act(() => jest.advanceTimersByTimeAsync(1000));
      await failure;
      expect(queryFn).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
      jest.useRealTimers();
    }
  }
);
