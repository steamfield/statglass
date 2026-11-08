import { capabilities } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { DAY_MS } from "@core/time-grid";
import { act, screen, waitFor, within } from "@testing-library/react";
import { pushLayout } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { ChartRangeProvider } from "~/stores/chart-range";
import { OverviewAppsCard } from "./apps-card";

const NOW = 1_800_000_000_000;

it.each([900_000, DAY_MS])(
  "gates segments and labels energy by path at %i ms",
  async (windowMs) => {
    const { transport, user } = renderWithProviders(
      <OverviewAppsCard origin="tr" windowMs={windowMs} />,
      {
        transportOptions: { now: () => NOW },
      }
    );
    await screen.findByRole("list");
    const group = screen.getByRole("radiogroup", { name: "Rank apps by" });
    expect(within(group).getByRole("radio", { name: "CPU" })).toBeVisible();
    expect(within(group).getByRole("radio", { name: "Memory" })).toBeVisible();
    expect(within(group).getByRole("radio", { name: "GPU" })).toBeVisible();
    expect(within(group).queryByRole("radio", { name: "Network" })).toBeNull();
    const energyLabel = windowMs === DAY_MS ? "CPU power" : "Energy";
    await user.click(within(group).getByRole("radio", { name: energyLabel }));
    await screen.findByRole("list", {
      name:
        windowMs === DAY_MS
          ? "Top apps by CPU power est."
          : "Top apps by Energy",
    });
    if (windowMs === DAY_MS)
      expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Editor");
    act(() =>
      transport.push({
        kind: "caps",
        capabilities: {
          ...capabilities(transport.flags, {}),
          process_energy: false,
          process_gpu: false,
        },
      })
    );
    expect(screen.queryByRole("radio", { name: energyLabel })).toBeNull();
    expect(screen.queryByRole("radio", { name: "GPU" })).toBeNull();
    expect(screen.getByRole("radio", { name: "CPU" })).toBeChecked();
    await screen.findByRole("list", { name: "Top apps by Avg CPU" });
  }
);

it("falls back from GPU when that capability disappears", async () => {
  const { transport, user } = renderWithProviders(
    <OverviewAppsCard origin="tr" windowMs={DAY_MS} />
  );
  await screen.findByRole("radio", { name: "GPU" });
  await user.click(screen.getByRole("radio", { name: "GPU" }));
  await screen.findByRole("list", { name: "Top apps by Avg GPU" });
  act(() =>
    transport.push({
      kind: "caps",
      capabilities: {
        ...capabilities(transport.flags, {}),
        process_gpu: false,
      },
    })
  );
  expect(screen.getByRole("radio", { name: "CPU" })).toBeChecked();
});

it("shows history errors without a fallback", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.queryHistoricalUsage = async () => ({
    status: "error",
    error: { kind: "remote_unreachable", message: "disconnected" },
  });
  const live = vi.spyOn(transport, "queryUsageByApp");
  renderWithProviders(<OverviewAppsCard origin="tr" windowMs={DAY_MS} />, {
    transport,
  });
  expect(await screen.findByText("Couldn't load app history")).toBeVisible();
  expect(live).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uses range-aware empty text (absolute: %s)",
  async (absolute) => {
    const transport = createMockTransport({
      autoTick: false,
      now: () => NOW,
      chartWindow: absolute
        ? { absolute: { from_ms: NOW - DAY_MS, to_ms: NOW } }
        : { relative: DAY_MS },
    });
    const read = transport.queryHistoricalUsage;
    transport.queryHistoricalUsage = async (request) => {
      const result = await read(request);
      return result.status === "ok"
        ? { ...result, data: { ...result.data, apps: [] } }
        : result;
    };
    renderWithProviders(
      <ChartRangeProvider>
        <OverviewAppsCard origin="tr" windowMs={DAY_MS} />
      </ChartRangeProvider>,
      { transport }
    );
    expect(
      await screen.findByText(
        absolute
          ? /No app activity recorded between/
          : "No app activity recorded in the last day"
      )
    ).toBeVisible();
  }
);

it.each([900_000, DAY_MS])(
  "does not render on a 1 Hz frame at %i ms",
  async (windowMs) => {
    const renders = { n: 0 };
    const { transport, queryClient } = renderWithProviders(
      <Profiler id="apps" onRender={() => renders.n++}>
        <OverviewAppsCard origin="tr" windowMs={windowMs} />
      </Profiler>,
      { transportOptions: { now: () => NOW } }
    );
    await screen.findByRole("list");
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const push = pushLayout(transport, 42, []);
    push(NOW + 1000, []);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const before = renders.n;
    push(NOW + 2000, []);
    expect(renders.n).toBe(before);
  }
);
