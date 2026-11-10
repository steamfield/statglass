import type { LiveProcess } from "@core/generated/bindings";
import type { ScenarioName } from "@core/mock/fixtures";
import {
  capabilities,
  MOCK_HOST_ID,
  PROCESSES,
  withGpuPct,
  withNetRates,
} from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import { seriesKey } from "@core/series-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { nextFrame, pushLayout } from "@tests/live-frames";
import { mockElementAnimate, renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { ChartRangeProvider } from "~/stores/chart-range";
import { type HostStore, useHostStore } from "~/stores/host-store";
import {
  OverviewBatteryCard,
  OverviewDiskCard,
  OverviewGpuCard,
  OverviewMemoryCard,
  OverviewNetworkCard,
  OverviewPowerCard,
} from "./overview-cards";

function renderCard(scenarios: ScenarioName[]) {
  const renders = { n: 0 };
  const view = renderWithProviders(
    <Profiler id="net" onRender={() => renders.n++}>
      <OverviewNetworkCard origin="tl" windowMs={300000} />
    </Profiler>,
    { transportOptions: { scenarios } }
  );
  return { ...view, renders };
}

const batch = (ts: number, rows: LiveProcess[]) => ({
  kind: "processes" as const,
  ts_ms: ts,
  rows,
});

describe("Overview Network card", () => {
  it("lists your processes by network rate when the host has per-process network", async () => {
    const { transport } = renderCard(["default"]);
    await screen.findByRole("heading", { name: "Network" });
    act(() => transport.push(batch(1, withNetRates(PROCESSES))));
    const list = await screen.findByRole("list", {
      name: "Top processes by network rate",
    });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "SSafari22.1 MB/s",
      "ccom.docker.backend9.6 MB/s",
      "nnode4.2 MB/s",
      "XXcode1.8 MB/s",
      "FFigma700 KB/s",
    ]);
    expect(screen.getByText("Your processes only")).toBeInTheDocument();
  });

  it("keeps the interface list, and ignores process batches, without it", async () => {
    const { transport, renders } = renderCard(["no-process-network"]);
    await screen.findByRole("list", { name: "Interfaces by total rate" });
    expect(screen.queryByText("Your processes only")).toBeNull();
    const before = renders.n;
    act(() => transport.push(batch(1, withNetRates(PROCESSES))));
    act(() => transport.push(batch(2, PROCESSES)));
    expect(renders.n).toBe(before);
  });
});

function renderGpuCard(scenarios: ScenarioName[]) {
  const renders = { n: 0 };
  const view = renderWithProviders(
    <Profiler id="gpu" onRender={() => renders.n++}>
      <OverviewGpuCard origin="tl" windowMs={300000} />
    </Profiler>,
    { transportOptions: { scenarios, autoTick: false } }
  );
  return { ...view, renders };
}

describe("Overview GPU card (D-085)", () => {
  it("lists your processes by GPU share when the host has per-process GPU", async () => {
    const { transport } = renderGpuCard(["default"]);
    await screen.findByRole("heading", { name: "GPU" });
    // The first sample after the view opens is a baseline: no shares yet.
    act(() => transport.push(batch(1, PROCESSES)));
    expect(
      await screen.findByText("Measuring GPU by process…")
    ).toBeInTheDocument();
    act(() => transport.push(batch(2, withGpuPct(PROCESSES))));
    const list = await screen.findByRole("list", {
      name: "Top processes by GPU",
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((r) => r.textContent)
    ).toEqual([
      "WWindowServer14.2%",
      "FFigma9.8%",
      "SSafari5.1%",
      "XXcode3.4%",
      "ccom.docker.backend0.6%",
    ]);
    expect(screen.getByText("Your processes only")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /GPU utilization, last 5 minutes/ })
    ).toBeInTheDocument();
  });

  it("keeps the history chart, and ignores process batches, without it", async () => {
    const { transport, renders } = renderGpuCard(["no-process-gpu"]);
    await screen.findByRole("heading", { name: "GPU" });
    expect(
      screen.getByRole("img", { name: /GPU utilization, last 5 minutes/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Top processes by GPU" })
    ).toBeNull();
    const before = renders.n;
    act(() => transport.push(batch(1, withGpuPct(PROCESSES))));
    act(() => transport.push(batch(2, PROCESSES)));
    expect(renders.n).toBe(before);
  });
});

it("shows a failed disk inventory instead of loading indefinitely", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.listDiskIoDevices = async () => ({
    status: "error",
    error: { kind: "unknown_host", host: MOCK_HOST_ID },
  });
  renderWithProviders(<OverviewDiskCard origin="tl" windowMs={300000} />, {
    transport,
  });
  expect(await screen.findByText("Couldn't load disk devices.")).toBeVisible();
  expect(screen.queryByText("Loading chart history…")).toBeNull();
});

it("uses the local inventory's disk3 default for current headline rates", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.listDiskIoDevices = async () => ({
    status: "ok",
    data: {
      default_device: "disk3",
      devices: [
        {
          dev: "disk0",
          name: "Other",
          internal: true,
          default: false,
          request_time_supported: true,
        },
        {
          dev: "disk3",
          name: "Boot",
          internal: true,
          default: true,
          request_time_supported: true,
        },
      ],
    },
  });
  renderWithProviders(<OverviewDiskCard origin="tl" windowMs={300000} />, {
    transport,
  });
  await screen.findByRole("img", { name: /^Disk I\/O/ });
  const frame = pushLayout(transport, 2, [
    seriesKey("disk.read", { dev: "disk0" }),
    seriesKey("disk.write", { dev: "disk0" }),
    seriesKey("disk.read", { dev: "disk3" }),
    seriesKey("disk.write", { dev: "disk3" }),
  ]);
  frame(Date.now() + 1000, [1e6, 2e6, 90e6, 30e6]);
  expect(screen.getByText("↑ 90.0 MB/s ↓ 30.0 MB/s")).toBeVisible();
});

it("uses a remote capability's non-first default without local inventory", async () => {
  const transport = createMockTransport({ autoTick: false });
  const getHost = transport.getHost;
  transport.getHost = async (host) => {
    const result = await getHost(host);
    return result.status === "ok"
      ? { ...result, data: { ...result.data, is_local: false } }
      : result;
  };
  const view = renderWithProviders(
    <OverviewDiskCard origin="tl" windowMs={300000} />,
    { transport }
  );
  await screen.findByRole("heading", { name: "Disk" });
  act(() =>
    transport.push({
      kind: "caps",
      capabilities: {
        ...capabilities(transport.flags, {}),
        disk_devices: [
          { dev: "sda", name: "First", internal: true, default: false },
          { dev: "sdb", name: "Default", internal: true, default: true },
        ],
      },
    })
  );
  await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
  const frame = pushLayout(transport, 2, [
    seriesKey("disk.read", { dev: "sda" }),
    seriesKey("disk.write", { dev: "sda" }),
    seriesKey("disk.read", { dev: "sdb" }),
    seriesKey("disk.write", { dev: "sdb" }),
  ]);
  frame(Date.now() + 1000, [1e6, 2e6, 80e6, 20e6]);
  expect(screen.getByText("↑ 80.0 MB/s ↓ 20.0 MB/s")).toBeVisible();
  expect(
    transport.calls.some((call) => call.command === "list_disk_io_devices")
  ).toBe(false);
});

it.each([
  { name: "Disk", Card: OverviewDiskCard, capability: "process_disk_io" },
  { name: "Power", Card: OverviewPowerCard, capability: "process_energy" },
])(
  "$name ignores process batches without its process capability",
  async ({ Card, capability }) => {
    const renders = { n: 0 };
    const { transport, queryClient } = renderWithProviders(
      <Profiler id="card" onRender={() => renders.n++}>
        <Card origin="tl" windowMs={300000} />
      </Profiler>
    );
    await screen.findByRole("img");
    act(() =>
      transport.push({
        kind: "caps",
        capabilities: {
          ...capabilities(transport.flags, {}),
          [capability]: false,
        },
      })
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const before = renders.n;
    act(() => transport.push(batch(1, PROCESSES)));
    act(() => transport.push(batch(2, withGpuPct(PROCESSES))));
    expect(renders.n).toBe(before);
  }
);

it("hides the held Disk plot when an inventory refetch fails", async () => {
  const { transport, queryClient } = renderWithProviders(
    <OverviewDiskCard origin="tl" windowMs={300000} />
  );
  await screen.findByRole("img", { name: /^Disk I\/O/ });
  transport.listDiskIoDevices = async () => ({
    status: "error",
    error: { kind: "unknown_host", host: MOCK_HOST_ID },
  });
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: hostKeys.diskIoDevices(MOCK_HOST_ID),
    });
  });
  expect(await screen.findByText("Couldn't load disk devices.")).toBeVisible();
  expect(screen.queryByRole("img", { name: /^Disk I\/O/ })).toBeNull();
});

it("charts used memory for a Linux host even when the layout carries macOS composition", async () => {
  const transport = createMockTransport({ autoTick: false });
  const getHost = transport.getHost;
  transport.getHost = async (host) => {
    const result = await getHost(host);
    return result.status === "ok"
      ? {
          ...result,
          data: { ...result.data, info: { ...result.data.info, os: "linux" } },
        }
      : result;
  };
  renderWithProviders(<OverviewMemoryCard origin="tl" windowMs={300000} />, {
    transport,
  });
  expect(
    await screen.findByRole("img", { name: /^Memory used and cached files/ })
  ).toBeVisible();
  expect(screen.queryByRole("img", { name: /^Memory pressure/ })).toBeNull();
});

it.each(["cpu.total", "power.system"])(
  "Battery facts ignore a %s-only frame while the selected history stays fixed",
  async (metric) => {
    let store: HostStore | undefined;
    function GrabStore() {
      store = useHostStore();
      return null;
    }
    const renders = { n: 0 };
    const to = Date.now() - 86400000;
    const { transport, queryClient } = renderWithProviders(
      <>
        <GrabStore />
        <ChartRangeProvider>
          <Profiler id="battery" onRender={() => renders.n++}>
            <OverviewBatteryCard origin="tl" windowMs={900000} />
          </Profiler>
        </ChartRangeProvider>
      </>,
      {
        transportOptions: {
          chartWindow: { absolute: { from_ms: to - 900000, to_ms: to } },
        },
      }
    );
    await screen.findByRole("img", { name: /^Battery charge, selected dates/ });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const state = store?.getState();
    if (!state) throw new Error("No host store");
    const before = renders.n;
    act(() => transport.push(nextFrame(state, { [metric]: 80 })));
    expect(renders.n).toBe(before);
    const after = store?.getState();
    if (!after) throw new Error("No host store");
    act(() => transport.push(nextFrame(after, { "battery.charge": 50 })));
    expect(renders.n).toBeGreaterThan(before);
    expect(screen.getByText("50%")).toBeVisible();
  }
);

it.each([
  ["GPU", OverviewGpuCard, /^GPU utilization/],
  ["Network", OverviewNetworkCard, /^Network:/],
])(
  "%s shows a loading frame during backfill and data afterwards",
  async (_name, Card, label) => {
    vi.useFakeTimers();
    const animate = mockElementAnimate();
    document.documentElement.style.setProperty("--motion-enter", "280ms");
    const r = renderWithProviders(<Card origin="tl" windowMs={3_600_000} />, {
      transportOptions: { historyRows: 3600 },
      backfillMs: 3_600_000,
    });
    try {
      await act(async () => {});
      expect(r.container.querySelector("[data-chart-loading]")).not.toBeNull();
      expect(r.container.querySelector("path[data-line]")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
      const chart = screen.getByRole("img", { name: label });
      if (_name === "GPU")
        expect(chart.querySelector("path[data-line]")).not.toBeNull();
      else {
        const bars = chart.querySelector("[data-bars]");
        expect(bars).toHaveAttribute("data-reveal");
        expect(animate.mock.contexts).toContain(bars);
      }
    } finally {
      r.unmount();
      r.transport.dispose();
      document.documentElement.style.removeProperty("--motion-enter");
      vi.useRealTimers();
    }
  }
);
