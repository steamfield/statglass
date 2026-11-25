import type { HostRecord } from "@core/generated/types";
import { MOCK_HOST_ID, type ScenarioName } from "@core/mock/fixtures";
import {
  PHONE_CLOCK_OFFSET_MS,
  PHONE_LAST_SEEN_MS,
  phoneCommandFailures,
} from "@core/mock/phone-errors";
import { createMockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { ExpoRoot, router, Stack, useLocalSearchParams } from "expo-router";
import {
  act,
  fireEvent,
  getMockContext,
  screen,
  waitFor,
} from "expo-router/testing-library";
import { AccessibilityInfo } from "react-native";
import HostsLayout from "@/app/(hosts)/_layout";
import HostsRoute from "@/app/(hosts)/index";
import { useHostSparkline } from "@/data/hosts";
import type { PhoneSettings } from "@/data/phone-settings";
import { Text } from "@/ui/text";

const NOW = new Date(2026, 10, 24, 14, 0).getTime();
const MINUTE = 60_000;

function HostDetails() {
  const { host } = useLocalSearchParams();
  return <Text variant="title">{`Details for ${host}`}</Text>;
}

const routes = getMockContext({
  _layout: () => <Stack />,
  index: () => <Text variant="title">First launch</Text>,
  "(hosts)/_layout": HostsLayout,
  "(hosts)/index": HostsRoute,
  "(hosts)/[host]/index": HostDetails,
  "(hosts)/[host]/[module]": HostDetails,
  "settings/index": () => <Text variant="title">Settings screen</Text>,
  pair: () => <Text variant="title">Pairing screen</Text>,
  demo: () => <Text variant="title">Demo entry</Text>,
});

async function renderHosts(
  transport?: ReturnType<typeof createMockTransport>,
  settings?: Partial<PhoneSettings>
) {
  const result = await renderWithProviders(
    <ExpoRoot context={routes} location="/(hosts)" />,
    {
      ...(transport ? { transport } : {}),
      ...(settings ? { settings } : {}),
      demo: true,
    }
  );
  if (transport) {
    await waitFor(() =>
      expect(result.client.getQueryState(hostKeys.list())?.fetchStatus).toBe(
        "idle"
      )
    );
  }
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
    screen.getAllByRole("button", { name: /CPU.*, Memory.*, Network/ })
  ).toHaveLength(records.length);
  expect(
    screen.getAllByRole("button", { name: /CPU.*, Memory.*, Network/ })[0]
  ).toBe(build);
  expect(
    await screen.findByRole("button", {
      name: /macOS, Live, CPU 18%, Memory 42%/,
    })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", {
      name: "offline, Linux, Offline since 14:02, CPU —, Memory —, Network —",
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

test("uses the four row series once and stops reading on blur", async () => {
  const transport = sparklineDemo();
  const vitals = jest.spyOn(transport, "hostVitals");
  const history = jest.spyOn(transport, "hostHistory");
  const [local] = await transport.listHosts();
  await renderHosts(transport);
  await screen.findByLabelText("CPU history over the last 30 minutes");
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

test("describes the CPU sparkline in the host row's accessible name", async () => {
  const transport = sparklineDemo();
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: /MacBook Pro.*CPU history over the last 30 minutes/,
    })
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
    await screen.findByRole("header", { name: "First launch" })
  ).toBeOnTheScreen();
});

test("shows missing readings as dashes", async () => {
  const transport = createMockTransport({ scenarios: ["host-unreachable"] });
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: "unreachable, Linux, Needs attention · Host unreachable, CPU —, Memory —, Network —",
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
      name: "build, Linux, Offline since 14:02, CPU —, Memory —, Network —",
    })
  ).toBeOnTheScreen();
  expect(
    screen.queryByLabelText("CPU history over the last 30 minutes")
  ).toBeNull();
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
    screen.queryByLabelText("CPU history over the last 30 minutes")
  ).toBeNull();
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
