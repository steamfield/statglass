import { formatPercent } from "@core/format";
import type { HostHistoryRequest, HostRecord } from "@core/generated/types";
import { MOCK_HOST_ID, type ScenarioName } from "@core/mock/fixtures";
import { phoneDemoOptions } from "@core/mock/history";
import {
  PHONE_CLOCK_OFFSET_MS,
  PHONE_LAST_SEEN_MS,
  phoneCommandFailures,
} from "@core/mock/phone-errors";
import { ok } from "@core/mock/protocol";
import { createMockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { FakeNative, ok as nativeOk } from "@test/transport/fake-native";
import { REMOTE } from "@test/transport/native-fixtures";
import { ExpoRoot, router, Stack, useLocalSearchParams } from "expo-router";
import {
  act,
  fireEvent,
  getMockContext,
  screen,
  waitFor,
} from "expo-router/testing-library";
import { AccessibilityInfo, Dimensions } from "react-native";
import HostsLayout from "@/app/(hosts)/_layout";
import HostsRoute from "@/app/(hosts)/index";
import FirstLaunch from "@/app/index";
import { useHostSparkline } from "@/data/hosts";
import type { PhoneSettings } from "@/data/phone-settings";
import type { PhoneTransport } from "@/data/seam";
import { themeColors } from "@/theme.generated";
import { createNativeTransport } from "@/transport/native-transport";
import { Text } from "@/ui/text";

const NOW = new Date(2026, 10, 24, 14, 0).getTime();
const MINUTE = 60_000;

function HostDetails() {
  const { host } = useLocalSearchParams();
  return <Text variant="title">{`Details for ${host}`}</Text>;
}

const routes = getMockContext({
  _layout: () => <Stack />,
  index: FirstLaunch,
  "(hosts)/_layout": HostsLayout,
  "(hosts)/index": HostsRoute,
  "(hosts)/[host]/index": HostDetails,
  "(hosts)/[host]/[module]": HostDetails,
  "settings/index": () => <Text variant="title">Settings screen</Text>,
  pair: () => <Text variant="title">Pairing screen</Text>,
  demo: () => <Text variant="title">Demo entry</Text>,
});

async function renderHosts(
  transport?: PhoneTransport,
  settings?: Partial<PhoneSettings>,
  demo = true
) {
  const result = await renderWithProviders(
    <ExpoRoot context={routes} location="/(hosts)" />,
    {
      ...(transport ? { transport } : {}),
      ...(settings ? { settings } : {}),
      demo,
    }
  );
  if (transport) {
    await screen.findByLabelText("Hosts list");
    await waitFor(
      () => expect(screen.queryByText("Loading hosts…")).toBeNull(),
      { timeout: 5_000 }
    );
  }
  // Read the same roster that supplied FlatList's native item keys. Error
  // cases have no items to report as visible.
  const records = result.client.getQueryData<HostRecord[]>(hostKeys.list());
  if (records) {
    await fireEvent(
      screen.getByLabelText("Hosts list"),
      "viewableItemsChanged",
      {
        viewableItems: records
          .filter(({ id }) => !settings?.removed?.includes(id))
          .map(({ id }) => ({ key: id })),
      }
    );
  }
  return result;
}

function demo() {
  return createMockTransport({
    scenarios: ["hosts-dashboard", "host-incompatible"],
    historyRows: 2,
  });
}

function sparklineDemo(scenarios: readonly ScenarioName[] = ["default"]) {
  return createMockTransport({
    scenarios: [...scenarios, "phone-sparkline-gap"],
    historyRows: 2,
  });
}

function pullToRefresh() {
  const [control] = screen.container.queryAll(
    (node) => node.type === "RCTRefreshControl"
  );
  if (!control) throw new Error("Expected the iOS pull-to-refresh control");
  return fireEvent(control, "refresh");
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockAppState();
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows local and remote hosts in phone order with OS, statuses and headline readings", async () => {
  const transport = demo();
  const records = await transport.listHosts();
  const { cpu_pct, memory_pct } = await unwrap(
    transport.hostVitals(MOCK_HOST_ID)
  );
  transport.pushRemoteStatus("remote-build", {
    state: "connecting",
    error: null,
  });
  transport.pushRemoteStatus("remote-offline", {
    last_seen_ms: PHONE_LAST_SEEN_MS,
    clock_offset_ms: PHONE_CLOCK_OFFSET_MS,
  });
  await renderHosts(transport, {
    hostOrder: ["remote-build"],
    hostNames: { "remote-build": "Build server" },
  });

  const build = await screen.findByRole("button", {
    name: "Build server, Linux, Connecting, CPU —, Memory —, Network —",
  });
  expect(
    screen.getAllByRole("button", { name: /, Linux|, macOS/ })
  ).toHaveLength(records.length);
  expect(screen.getAllByRole("button", { name: /, Linux|, macOS/ })[0]).toBe(
    build
  );
  expect(
    await screen.findByRole("button", {
      name: new RegExp(
        `macOS, Live, CPU ${formatPercent(cpu_pct)}, Memory ${formatPercent(memory_pct)}`
      ),
    })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", {
      name: "offline, Linux, Offline since 14:02",
    })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", {
      name: /legacy, Linux, Needs attention · Incompatible StatGlass connection/,
    })
  ).toBeOnTheScreen();
  expect(screen.getByText("Demo")).toBeOnTheScreen();
  await fireEvent.press(build);
  expect(
    await screen.findByRole("header", { name: "Details for remote-build" })
  ).toBeOnTheScreen();
});

test("uses compact summaries and one history read, and stops reading on blur", async () => {
  const transport = sparklineDemo();
  const vitals = jest.spyOn(transport, "hostVitals");
  const history = jest.spyOn(transport, "hostHistory");
  const subscribe = jest.spyOn(transport, "subscribeLive");
  const [local] = await transport.listHosts();
  await renderHosts(transport);
  await screen.findByLabelText(/^CPU history over the last 30 minutes/);
  const request = history.mock.calls[0]?.[0];
  if (!request || request.to_ms === null || !local)
    throw new Error("Expected the local host and its history request");
  expect(request).toMatchObject({
    host: local.id,
    series: ["cpu.total", "mem.used", "net.rx_total", "net.tx_total"].map(
      (metric) => ({ metric, labels: [] })
    ),
    events_for: null,
  });
  expect(request.to_ms - request.from_ms).toBe(30 * MINUTE);
  expect(request.max_points).toBeLessThan(Dimensions.get("window").width / 5);
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: local.id, level: "compact" }])
  );
  expect(subscribe.mock.calls).toEqual([
    [
      local.id,
      expect.any(Function),
      { series: request.series, backfillMs: 0, minPeriodMs: 5_000 },
    ],
  ]);

  await act(() => jest.advanceTimersByTimeAsync(5_000));
  expect(vitals).toHaveBeenCalledTimes(1);
  expect(history).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTimeAsync(55_000));
  expect(history).toHaveBeenCalledTimes(1);

  await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
  const vitalsAtBlur = vitals.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(MINUTE));
  expect(vitals).toHaveBeenCalledTimes(vitalsAtBlur);
  expect(history).toHaveBeenCalledTimes(1);
});

test("updates status from transport events and pull to refresh retries only visible offline hosts", async () => {
  const transport = demo();
  const retry = jest.spyOn(transport, "retryRemoteHost");
  const list = jest.spyOn(transport, "listHosts");
  const vitals = jest.spyOn(transport, "hostVitals");
  const history = jest.spyOn(transport, "hostHistory");
  await renderHosts(transport, { removed: ["remote-nas"] });
  expect(
    await screen.findByRole("button", { name: /build, Linux, Live/ })
  ).toBeOnTheScreen();
  await act(() => {
    transport.pushRemoteStatus("remote-build", {
      state: "connecting",
      error: null,
    });
    transport.pushRemoteStatus("remote-nas", { state: "offline" });
  });
  expect(
    await screen.findByRole("button", { name: /build, Linux, Connecting/ })
  ).toBeOnTheScreen();
  vitals.mockClear();
  history.mockClear();
  await pullToRefresh();
  expect(
    await screen.findByRole("button", { name: /offline, Linux, Live/ })
  ).toBeOnTheScreen();
  expect(retry.mock.calls).toEqual([["remote-offline"]]);
  expect(list).toHaveBeenCalledTimes(2);
  expect(vitals).toHaveBeenCalledWith("remote-offline");
  expect(history).toHaveBeenCalledWith(
    expect.objectContaining({ host: "remote-offline" })
  );
});

test.each([false, true])(
  "reports and logs every failed host retry (multiple failures: %s)",
  async (multiple) => {
    const transport = demo();
    if (multiple)
      transport.pushRemoteStatus("remote-build", { state: "offline" });
    const { retryTimeout, retryNetwork } = phoneCommandFailures;
    if (multiple) transport.failNext("retryRemoteHost", retryNetwork);
    transport.failNext("retryRemoteHost", retryTimeout);
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await renderHosts(transport, {
      hostNames: {
        "remote-build": "Build server",
        "remote-offline": "Lab server",
      },
    });
    await screen.findByRole("button", { name: /Lab server, Linux, Offline/ });
    await pullToRefresh();

    const summary = multiple
      ? "Couldn't reconnect 2 hosts"
      : "Couldn't reconnect Lab server: The host timed out.";
    expect(
      await screen.findByRole("alert", { name: summary })
    ).toBeOnTheScreen();
    const logged = [["remote-offline", retryTimeout]];
    if (multiple) {
      expect(
        screen.getByText("Build server: The network is unreachable.")
      ).toBeOnTheScreen();
      expect(
        screen.getByText("Lab server: The host timed out.")
      ).toBeOnTheScreen();
      logged.push(["remote-build", retryNetwork]);
    }
    expect(warn.mock.calls).toHaveLength(logged.length);
    for (const [id, error] of logged) {
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        id,
        expect.objectContaining({ error })
      );
    }
  }
);

test("a sparkline requested by id waits for status and ends at the remote host's now", async () => {
  const transport = demo();
  const id = "remote-build";
  transport.pushRemoteStatus(id, { clock_offset_ms: -10 * MINUTE });
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
  const readStatus = jest.spyOn(transport, "listRemoteHosts");
  const history = jest.spyOn(transport, "hostHistory");
  function SparklineScreen() {
    useHostSparkline(id);
    return null;
  }
  const context = getMockContext({ index: SparklineScreen });
  await renderWithProviders(<ExpoRoot context={context} location="/" />, {
    transport,
  });
  expect(history).not.toHaveBeenCalled();
  await waitFor(() => expect(readStatus).toHaveBeenCalled());
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await waitFor(() => expect(history).toHaveBeenCalled());
  expect(readStatus).toHaveBeenCalledTimes(2);
  const [request] = history.mock.calls[0] ?? [];
  if (!request || request.to_ms === null)
    throw new Error("Expected the history request time");
  expect(request.host).toBe(id);
  expect(request.to_ms - request.from_ms).toBe(30 * MINUTE);
  expect(request.to_ms).toBeGreaterThanOrEqual(NOW + 1000 - 10 * MINUTE);
  expect(request.to_ms).toBeLessThanOrEqual(Date.now() - 10 * MINUTE);
});

test("uses integer epoch milliseconds even with a fractional monotonic clock", async () => {
  const transport = createMockTransport();
  const history = jest.spyOn(transport, "hostHistory");
  let elapsed = 0;
  jest.spyOn(performance, "now").mockImplementation(() => {
    elapsed += 0.161;
    return elapsed;
  });
  await renderHosts(transport);
  await waitFor(() => expect(history).toHaveBeenCalled());
  const request = history.mock.calls[0]?.[0];
  expect(Number.isInteger(request?.from_ms)).toBe(true);
  expect(Number.isInteger(request?.to_ms)).toBe(true);
});

test("describes three charts, their measured peaks and gaps, and labels the percentage ceilings", async () => {
  const transport = sparklineDemo();
  const [host] = await transport.listHosts();
  if (!host) throw new Error("Expected a host fixture");
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => {
    const series = [
      ["cpu.total", 5, 24],
      [
        "mem.used",
        host.info.mem_total_bytes / 10,
        host.info.mem_total_bytes / 5,
      ],
      ["net.rx_total", 1000, 2000],
      ["net.tx_total", 100, 200],
    ] as const;
    return ok({
      tier: "m1",
      bucket_ms: MINUTE,
      complete_to_ms: request.to_ms ?? NOW,
      gaps: [],
      events: [],
      stats: [],
      clamped: [],
      series: series.map(([metric, first, last]) => ({
        key: { metric, labels: [] },
        hold_ms: MINUTE,
        points: [
          { t: request.from_ms, avg: first, min: first, max: first },
          {
            t: request.from_ms + 2 * MINUTE,
            avg: last * 0.7,
            min: last * 0.5,
            max: last,
          },
        ],
      })),
    });
  });
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: /MacBook Pro.*CPU history over the last 30 minutes, peak 24%, gaps in history.*Memory history over the last 30 minutes, peak 20%, gaps in history.*Network history over the last 30 minutes, download peak 2\.0 KB\/s, upload peak 200 B\/s, gaps in history/,
    })
  ).toBeOnTheScreen();
  expect(screen.getByText("30%")).toBeOnTheScreen();
  expect(screen.getByText("25%")).toBeOnTheScreen();
  for (const metric of ["CPU", "Memory", "Network"]) {
    expect(
      screen.getByRole("image", {
        name: new RegExp(`^${metric} history over the last 30 minutes`),
      })
    ).toBeOnTheScreen();
  }
  expect(screen.getByText("18%")).toHaveStyle({
    color: themeColors.light["cpu-ink"],
  });
  expect(screen.getByText("42%")).toHaveStyle({
    color: themeColors.light["mem-ink"],
  });
  expect(screen.getByText("1.4 MB/s")).toHaveStyle({
    color: themeColors.light["net-ink"],
  });
});

test("connected rows dim when summaries stop and brighten when they resume", async () => {
  const transport = sparklineDemo();
  await renderHosts(transport);
  const live = /^MacBook Pro, macOS, Live, CPU 18%/;
  await screen.findByRole("button", { name: live });
  await act(() => jest.advanceTimersByTimeAsync(15_000));
  const stale = await screen.findByRole("button", {
    name: /^MacBook Pro, macOS, Stale, CPU 18%/,
  });
  expect(stale).toHaveStyle({ opacity: 0.5 });
  await act(() => transport.tick());
  expect(
    await screen.findByRole("button", {
      name: /^MacBook Pro, macOS, Live, CPU \d+%/,
    })
  ).not.toHaveStyle({
    opacity: 0.5,
  });
});

test("uses the host's ten-second cadence without inventing gaps", async () => {
  const transport = createMockTransport(
    phoneDemoOptions({ autoTick: true, intervalMs: 10_000, historyRows: 2 })
  );
  try {
    await renderHosts(transport);
    await screen.findByRole("button", { name: /^MacBook Pro.*CPU history/ });
    await act(() => jest.advanceTimersByTimeAsync(30_000));
    expect(
      screen.getByRole("button", {
        name: /^MacBook Pro, macOS, Live.*CPU history/,
      })
    ).not.toHaveAccessibleName(/gaps in history/);
  } finally {
    transport.dispose();
  }
});

test("a paused sampler stays paused when no summaries arrive", async () => {
  const transport = createMockTransport({
    scenarios: ["paused"],
    historyRows: 2,
  });
  await renderHosts(transport);
  await act(() => jest.advanceTimersByTimeAsync(30_000));
  expect(
    screen.getByRole("button", { name: /^MacBook Pro, macOS, Paused,/ })
  ).not.toHaveStyle({ opacity: 0.5 });
});

test.each([
  ["hosts-dashboard", "remote-build", "build"],
  ["host-offline-history", MOCK_HOST_ID, "MacBook Pro"],
] as const)(
  "compact updates join demo history in %s",
  async (scenario, host, name) => {
    const transport = createMockTransport(
      phoneDemoOptions({
        scenarios: [scenario],
        autoTick: true,
        historyRows: 2,
      })
    );
    try {
      const hidden = (await transport.listHosts())
        .filter(({ id }) => id !== host)
        .map(({ id }) => id);
      await renderHosts(transport, { removed: hidden });
      const chartName = new RegExp(
        `^${name}.*CPU history.*Memory history.*Network history`
      );
      await screen.findByRole("button", { name: chartName });
      await act(() => jest.advanceTimersByTimeAsync(10_000));
      expect(
        screen.getByRole("button", { name: chartName })
      ).not.toHaveAccessibleName(/gaps in history/);
    } finally {
      transport.dispose();
    }
  }
);

test("a host brought back into view rejoins history after the time it was offscreen", async () => {
  const transport = createMockTransport(
    phoneDemoOptions({ autoTick: true, historyRows: 2 })
  );
  const history = jest.spyOn(transport, "hostHistory");
  try {
    await renderHosts(transport);
    await screen.findByRole("button", {
      name: /^MacBook Pro.*Network history/,
    });
    const show = (keys: string[]) =>
      fireEvent(screen.getByLabelText("Hosts list"), "viewableItemsChanged", {
        viewableItems: keys.map((key) => ({ key })),
      });
    await show([]);
    await act(() => jest.advanceTimersByTimeAsync(20_000));
    await show([MOCK_HOST_ID]);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    await act(() => jest.advanceTimersByTimeAsync(5_000));
    expect(
      screen.getByRole("button", {
        name: /^MacBook Pro.*CPU history.*Memory history.*Network history/,
      })
    ).not.toHaveAccessibleName(/gaps in history/);
  } finally {
    transport.dispose();
  }
});

test("shows Needs pairing on every row when this iPhone's key changed", async () => {
  const transport = demo();
  jest
    .spyOn(transport, "pairingState")
    .mockResolvedValue(ok({ hosts: 6, key_changed: true }));
  const records = await transport.listHosts();
  await renderHosts(transport, undefined, false);
  await screen.findByRole("button", {
    name: "MacBook Pro, macOS, Needs pairing",
  });
  expect(
    screen.getAllByRole("button", { name: /, Needs pairing$/ })
  ).toHaveLength(records.length);
  expect(transport.demand()).toEqual([]);
});

test("reports a failed pairing-state read and clears the error on refresh", async () => {
  const transport = createMockTransport({ historyRows: 2 });
  transport.failNext("pairingState", phoneCommandFailures.registry);
  transport.failNext("pairingState", phoneCommandFailures.registry);
  await renderHosts(transport, undefined, false);
  const alert = { name: /Couldn’t check pairing.*Host registry unavailable/ };
  expect(
    await screen.findByRole("alert", alert, { timeout: 5_000 })
  ).toBeOnTheScreen();
  await pullToRefresh();
  expect(screen.queryByRole("alert", alert)).toBeNull();
});

test("a failed summary subscription leaves loaded history visible and retries on refresh", async () => {
  const transport = sparklineDemo();
  transport.failNext("subscribeLive", phoneCommandFailures.revokedKey);
  await renderHosts(transport);
  expect(
    await screen.findByText(/Live summaries unavailable/)
  ).toBeOnTheScreen();
  expect(screen.getByRole("image", { name: /^CPU history/ })).toBeOnTheScreen();
  expect(screen.queryByText(/History unavailable/)).toBeNull();

  await pullToRefresh();
  await waitFor(() =>
    expect(screen.queryByText(/Live summaries unavailable/)).toBeNull()
  );
  await act(() => transport.tick());
  expect(screen.getByRole("image", { name: /^CPU history/ })).toBeOnTheScreen();
});

test("returns to welcome when the native registry loses its last host", async () => {
  const mock = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 2,
  });
  let hosts = (await mock.listHosts()).filter(
    ({ id }) => id === "remote-build"
  );
  const native = new FakeNative();
  const delayed = Promise.withResolvers<string>();
  let delayRoster = false;
  let requested = false;
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts") {
      if (delayRoster) {
        requested = true;
        return delayed.promise;
      }
      return nativeOk(hosts);
    }
    if (method === "list_remote_hosts") return nativeOk([]);
    if (method === "pairing_state")
      return nativeOk({ hosts: hosts.length, key_changed: false });
    return nativeOk(null);
  });
  await renderHosts(createNativeTransport(native), undefined, false);
  await screen.findByRole("button", {
    name: /^build, Linux, Status unavailable/,
  });
  await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
  delayRoster = true;
  await act(() => router.back());
  await waitFor(() => expect(requested).toBe(true));
  await act(() => {
    const oldRoster = nativeOk(hosts);
    hosts = [];
    native.emit("onCoreEvent", {
      event: JSON.stringify({ kind: "hosts_changed", hosts }),
    });
    delayed.resolve(oldRoster);
  });
  expect(
    await screen.findByRole("header", { name: "StatGlass" })
  ).toBeOnTheScreen();
});

test("draws a native memory trace as soon as the roster reports capacity", async () => {
  const [fixture] = await createMockTransport({ historyRows: 2 }).listHosts();
  if (!fixture) throw new Error("Expected a host fixture");
  const host = {
    ...fixture,
    id: REMOTE.id,
    display_name: REMOTE.name,
    is_local: false,
  };
  const native = new FakeNative();
  const call = native.call.getMockImplementation();
  let capacity = 0;
  native.call.mockImplementation(async (method, args) => {
    if (method === "list_hosts")
      return nativeOk([
        { ...host, info: { ...host.info, mem_total_bytes: capacity } },
      ]);
    if (method === "list_remote_hosts")
      return nativeOk([
        {
          ...REMOTE,
          waiting_for_network: false,
          clock_offset_ms: 0,
          connection: {
            ...REMOTE.connection,
            state: "connected",
            failure: null,
            message: null,
          },
        },
      ]);
    if (method === "host_vitals") return nativeOk(REMOTE.vitals);
    if (method === "host_history") {
      const { from_ms } = JSON.parse(args) as HostHistoryRequest;
      return nativeOk({
        tier: "m1",
        bucket_ms: MINUTE,
        complete_to_ms: NOW,
        gaps: [],
        events: [],
        stats: [],
        clamped: [],
        series: [
          {
            key: { metric: "mem.used", labels: [] },
            hold_ms: MINUTE,
            points: [{ t: from_ms, avg: 100, min: 100, max: 100 }],
          },
        ],
      });
    }
    if (method === "pairing_state")
      return nativeOk({ hosts: 1, key_changed: false });
    return call?.(method, args) ?? nativeOk(null);
  });
  await renderHosts(createNativeTransport(native), undefined, false);
  await screen.findByRole("button", {
    name: /^studio, macOS, Live.*Memory 7%/,
  });
  expect(screen.queryByLabelText(/^Memory history/)).toBeNull();
  await act(() => {
    capacity = 200;
    native.emit("onCoreEvent", {
      event: JSON.stringify({ kind: "remote_hosts_changed" }),
    });
  });
  expect(
    await screen.findByLabelText(
      /^Memory history over the last 30 minutes, peak 50%/
    )
  ).toBeOnTheScreen();
});

test("loads registry changes on return from a different screen", async () => {
  const transport = demo();
  const [remote] = await transport.listRemoteHosts();
  if (!remote) throw new Error("Expected a demo remote host");
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: new RegExp(`^${remote.config.name},`),
    })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
  await act(() =>
    transport.updateRemoteHost({ ...remote.config, name: "Updated host" })
  );
  await act(() => router.back());
  expect(
    await screen.findByRole("button", { name: /^Updated host,/ })
  ).toBeOnTheScreen();
});

test("retries a protocol-coded failure when the transport is still retrying", async () => {
  const transport = demo();
  const retry = jest.spyOn(transport, "retryRemoteHost");
  transport.pushRemoteStatus("remote-build", {
    state: "connecting",
    failure_kind: "protocol",
    error: "Codec error",
    last_seen_ms: NOW,
    clock_offset_ms: 0,
  });
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: /build, Linux, Needs attention · Couldn’t read host response/,
    })
  ).toBeOnTheScreen();
  await pullToRefresh();
  expect(
    await screen.findByRole("button", { name: /build, Linux, Live/ })
  ).toBeOnTheScreen();
  expect(retry).toHaveBeenCalledWith("remote-build");
});

test("a failed status read replaces stale Live and explains the failure", async () => {
  const transport = demo();
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", { name: /build, Linux, Live/ })
  ).toBeOnTheScreen();
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
  await act(() =>
    transport.pushRemoteStatus("remote-build", { state: "offline" })
  );
  expect(
    await screen.findByRole(
      "button",
      { name: /build, Linux, Status unavailable.*Status endpoint unavailable/ },
      { timeout: 5_000 }
    )
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole("button", { name: /build, Linux, Live/ })
  ).toBeNull();
});

test("offers the demo and pairing when the transport has no hosts", async () => {
  const transport = createMockTransport();
  await renderHosts(transport, { removed: [MOCK_HOST_ID] });
  expect(
    await screen.findByRole("header", { name: "No hosts yet" })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", { name: "Try demo hosts" })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Add a host" }));
  expect(
    await screen.findByRole("header", { name: "Pairing screen" })
  ).toBeOnTheScreen();
});

test("shows a failed host read as an error and recovers on refresh", async () => {
  const transport = createMockTransport();
  transport.failNext("listHosts", phoneCommandFailures.registry);
  transport.failNext("listHosts", phoneCommandFailures.registry);
  await renderHosts(transport);
  expect(
    await screen.findByRole(
      "alert",
      { name: /Host registry unavailable/ },
      { timeout: 5_000 }
    )
  ).toBeOnTheScreen();
  expect(screen.queryByRole("header", { name: "No hosts yet" })).toBeNull();
  await pullToRefresh();
  expect(
    await screen.findByRole("button", { name: /macOS, Live/ })
  ).toBeOnTheScreen();
});

test("redirects a direct hosts link to first launch before a transport is picked", async () => {
  await renderHosts();
  expect(
    await screen.findByRole("header", { name: "StatGlass" })
  ).toBeOnTheScreen();
});

test("collapses a host that needs attention to its status line", async () => {
  const transport = createMockTransport({ scenarios: ["host-unreachable"] });
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: "unreachable, Linux, Needs attention · Host unreachable",
    })
  ).toBeOnTheScreen();
});

test("going offline removes the previous readings and sparkline and stops polling them", async () => {
  const transport = sparklineDemo(["hosts-dashboard"]);
  const host = "remote-build";
  const hidden = (await transport.listHosts())
    .filter(({ id }) => id !== host)
    .map(({ id }) => id);
  const vitals = jest.spyOn(transport, "hostVitals");
  const history = jest.spyOn(transport, "hostHistory");
  await renderHosts(transport, { removed: hidden });
  expect(
    await screen.findByRole("button", {
      name: /build, Linux, Live, CPU 18%, Memory 42%, Network 1\.4 MB\/s, CPU history/,
    })
  ).toBeOnTheScreen();
  await act(() =>
    transport.pushRemoteStatus(host, {
      state: "offline",
      last_seen_ms: PHONE_LAST_SEEN_MS,
      clock_offset_ms: PHONE_CLOCK_OFFSET_MS,
    })
  );
  expect(await screen.findByText("Offline since 14:02")).toBeOnTheScreen();
  expect(
    screen.getByRole("button", {
      name: "build, Linux, Offline since 14:02",
    })
  ).toBeOnTheScreen();
  expect(
    screen.queryAllByLabelText(
      /^(CPU|Memory|Network) history over the last 30 minutes/
    )
  ).toHaveLength(0);
  vitals.mockClear();
  history.mockClear();
  await act(() => jest.advanceTimersByTimeAsync(MINUTE));
  expect(vitals).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});

test("reconnecting hides cached readings until the vitals and history reads succeed", async () => {
  const transport = sparklineDemo(["hosts-dashboard"]);
  const host = "remote-build";
  const hidden = (await transport.listHosts())
    .filter(({ id }) => id !== host)
    .map(({ id }) => id);
  await renderHosts(transport, { removed: hidden });
  const liveReadings =
    /build, Linux, Live, CPU 18%, Memory 42%, Network 1\.4 MB\/s, CPU history/;
  expect(
    await screen.findByRole("button", { name: liveReadings })
  ).toBeOnTheScreen();

  await act(() =>
    transport.pushRemoteStatus(host, {
      state: "connecting",
      failure_kind: "unreachable",
      last_seen_ms: PHONE_LAST_SEEN_MS,
    })
  );
  await screen.findByText("Offline since 14:02");
  transport.failNext("hostVitals", phoneCommandFailures.retryNetwork);
  transport.failNext("hostHistory", phoneCommandFailures.retryNetwork);
  await act(() =>
    transport.pushRemoteStatus(host, {
      state: "connected",
      failure_kind: null,
    })
  );
  await screen.findByText("Live");
  expect(
    screen.getByRole("button", {
      name: /^build, Linux, Live, CPU —, Memory —, Network —/,
    })
  ).toBeOnTheScreen();
  expect(
    screen.queryAllByLabelText(
      /^(CPU|Memory|Network) history over the last 30 minutes/
    )
  ).toHaveLength(0);
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(
    await screen.findByRole("button", { name: liveReadings })
  ).toBeOnTheScreen();
});

test("shows the phone offline once only while every listed remote waits for the network", async () => {
  const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  const transport = createMockTransport({
    scenarios: ["phone-errors"],
    historyRows: 2,
  });
  const visible = ["phone-local-offline", "phone-timeout"];
  const hidden = (await transport.listHosts())
    .filter(({ id }) => !visible.includes(id))
    .map(({ id }) => id);
  await renderHosts(transport, { removed: hidden });
  expect(await screen.findByText("Waiting for network")).toBeOnTheScreen();
  expect(screen.queryByText("This iPhone is offline")).toBeNull();

  await act(() =>
    transport.pushRemoteStatus("phone-timeout", {
      state: "connecting",
      waiting_for_network: true,
    })
  );
  expect(await screen.findByText("This iPhone is offline")).toBeOnTheScreen();
  expect(screen.getAllByText("This iPhone is offline")).toHaveLength(1);
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith("This iPhone is offline");
  expect(screen.getAllByText("Waiting for network")).toHaveLength(2);
});

test("shows the next agent retry in host time beside its short reason", async () => {
  const transport = createMockTransport({
    scenarios: ["phone-errors"],
    historyRows: 2,
  });
  await renderHosts(transport);
  expect(
    await screen.findByText(
      "Needs attention · StatGlass agent isn’t running · Retrying at 14:05"
    )
  ).toBeOnTheScreen();
});
