import { createMockTransport } from "@core/mock-transport";
import { DAY_MS } from "@core/time-grid";
import { act, screen, waitFor } from "@testing-library/react";
import { pushLayout } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { ChartRangeProvider } from "~/stores/chart-range";
import { type TopAppsMetric, useTopApps } from "./use-top-apps";

const NOW = 1_800_000_000_000;

function Probe({ windowMs }: { windowMs: number }) {
  const [by, setBy] = useState<TopAppsMetric>("cpu");
  const apps = useTopApps(windowMs, by);
  return (
    <>
      <button type="button" onClick={() => setBy("gpu")}>
        GPU
      </button>
      <output>{apps.historical ? "history" : "live"}</output>
      {apps.isError ? (
        <p>Error</p>
      ) : apps.beyondHistory ? (
        <p>Beyond history</p>
      ) : apps.isPending ? (
        <p>Loading</p>
      ) : (
        <ul>
          {apps.rows.map((row) => (
            <li key={row.id}>
              {row.name}: {row.value}
            </li>
          ))}
        </ul>
      )}
      {apps.note && <p>{apps.note}</p>}
    </>
  );
}

it.each([900_000, DAY_MS])(
  "uses the correct source for a %i ms window",
  async (windowMs) => {
    const transport = createMockTransport({ now: () => NOW, autoTick: false });
    renderWithProviders(<Probe windowMs={windowMs} />, { transport });
    await screen.findByRole("list");
    expect(
      screen.getByText(windowMs === DAY_MS ? "history" : "live")
    ).toBeVisible();
    expect(
      screen.getByText(windowMs === DAY_MS ? "Compiler: 30.0%" : "clang: 60.0%")
    ).toBeVisible();
    expect(screen.getAllByRole("listitem").length).toBeLessThanOrEqual(5);
  }
);

it("uses history for an absolute range inside the live hour", async () => {
  const transport = createMockTransport({
    autoTick: false,
    now: () => NOW,
    chartWindow: { absolute: { from_ms: NOW - 900_000, to_ms: NOW } },
  });
  const history = vi.spyOn(transport, "queryHistoricalUsage");
  renderWithProviders(
    <ChartRangeProvider>
      <Probe windowMs={900_000} />
    </ChartRangeProvider>,
    { transport }
  );
  await screen.findByRole("list");
  expect(screen.getByText("history")).toBeVisible();
  expect(history).toHaveBeenCalledWith(
    expect.objectContaining({ from_ms: NOW - 900_000, to_ms: NOW })
  );
});

it("queries again on metric change and does not show the previous metric's answer", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  const read = transport.queryHistoricalUsage;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const history = vi
    .spyOn(transport, "queryHistoricalUsage")
    .mockImplementation(async (request) => {
      if (request.by === "gpu") await gate;
      return read(request);
    });
  const { user } = renderWithProviders(<Probe windowMs={DAY_MS} />, {
    transport,
  });
  expect((await screen.findAllByRole("listitem"))[0]).toHaveTextContent(
    "Compiler: 30.0%"
  );
  await user.click(screen.getByRole("button", { name: "GPU" }));
  await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Loading")).toBeVisible();
  expect(screen.queryByRole("list")).toBeNull();
  await act(async () => release());
  await waitFor(() =>
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(
      "Browser: 7.5%"
    )
  );
});

it("holds the previous history answer across a 10 s move, then replaces it", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  const read = transport.queryHistoricalUsage;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const history = vi
    .spyOn(transport, "queryHistoricalUsage")
    .mockImplementation(async (request) => {
      const result = await read(request);
      if (request.to_ms > NOW) {
        await gate;
        if (result.status === "ok" && result.data.apps[0])
          result.data.apps[0].name = "New answer";
      }
      return result;
    });
  const { queryClient } = renderWithProviders(<Probe windowMs={DAY_MS} />, {
    transport,
  });
  await screen.findByRole("list");
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const push = pushLayout(transport, 42, []);
  push(NOW + 10_000, []);
  await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Loading")).toBeNull();
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Compiler");
  await act(async () => release());
  expect(await screen.findByText(/New answer/)).toBeVisible();
});

it("exposes incomplete history coverage and surfaces errors without a live fallback", async () => {
  const transport = createMockTransport({
    autoTick: false,
    now: () => NOW,
    scenarios: ["sleep-gap"],
  });
  const live = vi.spyOn(transport, "queryUsageByApp");
  const { queryClient } = renderWithProviders(<Probe windowMs={DAY_MS} />, {
    transport,
  });
  await screen.findByText(/incomplete observation/);
  transport.queryHistoricalUsage = async () => ({
    status: "error",
    error: { kind: "remote_unreachable", message: "disconnected" },
  });
  await act(() => queryClient.invalidateQueries());
  await screen.findByText("Error");
  expect(live).not.toHaveBeenCalled();
});

it("ends loading for a window beyond app history's supported range", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  const history = vi.spyOn(transport, "queryHistoricalUsage");
  renderWithProviders(<Probe windowMs={90 * DAY_MS} />, { transport });
  expect(await screen.findByText("Beyond history")).toBeVisible();
  expect(screen.queryByText("Error")).toBeNull();
  expect(screen.queryByText("Loading")).toBeNull();
  expect(history).not.toHaveBeenCalled();
});

it("limits a history answer to five rows", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  const read = transport.queryHistoricalUsage;
  transport.queryHistoricalUsage = async (request) => {
    const reply = await read(request);
    if (reply.status !== "ok") return reply;
    const app = reply.data.apps[0];
    if (!app) throw new Error("expected apps fixture");
    return {
      ...reply,
      data: {
        ...reply.data,
        apps: Array.from({ length: 7 }, (_, i) => ({
          ...app,
          name: String(i),
        })),
      },
    };
  };
  renderWithProviders(<Probe windowMs={DAY_MS} />, { transport });
  expect(await screen.findAllByRole("listitem")).toHaveLength(5);
});

it("does not show CPU-ranked rows while a live GPU query is pending", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  const read = transport.queryUsageByApp;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.queryUsageByApp = async (...args) => {
    if (args[3] === "gpu") await gate;
    return read(...args);
  };
  const { user } = renderWithProviders(<Probe windowMs={900_000} />, {
    transport,
  });
  await screen.findByRole("list");
  await user.click(screen.getByRole("button", { name: "GPU" }));
  expect(screen.getByText("Loading")).toBeVisible();
  expect(screen.queryByRole("list")).toBeNull();
  await act(async () => release());
  await waitFor(() =>
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Figma: 9.8%")
  );
});

it("keeps the live answer while the same metric's rolling range moves", async () => {
  const transport = createMockTransport({ autoTick: false, now: () => NOW });
  const read = transport.queryUsageByApp;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const live = vi
    .spyOn(transport, "queryUsageByApp")
    .mockImplementation(async (...args) => {
      if (args[2] > NOW) await gate;
      return read(...args);
    });
  const { queryClient } = renderWithProviders(<Probe windowMs={900_000} />, {
    transport,
  });
  await screen.findByRole("list");
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const before = screen.getByRole("list").textContent;
  const push = pushLayout(transport, 42, []);
  push(NOW + 10_000, []);
  await waitFor(() => expect(live).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Loading")).toBeNull();
  expect(screen.getByRole("list").textContent).toBe(before);
  await act(async () => release());
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
});
