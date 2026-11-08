import { createMockTransport } from "@core/mock-transport";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { ChartRangeProvider } from "~/stores/chart-range";
import { OverviewContainersCard } from "./containers-card";

const WINDOW = 900_000;

function setup(
  transport = createMockTransport({ autoTick: false, scenarios: ["docker-11"] })
) {
  const comparison = vi.spyOn(transport, "dockerComparison");
  const subscribe = vi.spyOn(transport, "dockerSubscribe");
  renderWithProviders(
    <ChartRangeProvider>
      <OverviewContainersCard windowMs={WINDOW} origin="tl" />
    </ChartRangeProvider>,
    { transport, route: "/dashboard/overview" }
  );
  return { comparison, subscribe };
}

const rows = async () =>
  within(await screen.findByRole("list", { name: "Busiest containers" }))
    .getAllByRole("link")
    .map((row) => row.textContent);

it("ranks the five containers that peaked highest over the window", async () => {
  const { comparison, subscribe } = setup();
  const names = (await rows()).map((row) => row?.replace(/[\d.]+%$/, ""));
  // docker-11's peaks, highest first: the retired worker spiked hardest.
  expect(names).toEqual([
    "retired-worker",
    "api",
    "Removed worker",
    "proxy",
    "worker",
  ]);
  const request = comparison.mock.calls.at(-1)?.[0];
  expect(request && request.to_ms - request.from_ms).toBe(WINDOW);
  expect(screen.getByText("Peak CPU")).toBeVisible();
  expect(screen.getByText(/^\d+ running$/)).toBeVisible();
  // A live stream would move Docker to its 1 s visible cadence.
  expect(subscribe).not.toHaveBeenCalled();
});

it("re-ranks by memory and links each row to its container", async () => {
  const { comparison } = setup();
  await rows();
  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  await waitFor(() =>
    expect(comparison.mock.calls.at(-1)?.[0].metric).toBe("memory")
  );
  await waitFor(async () => expect((await rows())[0]).toMatch(/[KMG]B$/));
  expect(screen.getByText("Peak memory")).toBeVisible();
  const first = within(
    screen.getByRole("list", { name: "Busiest containers" })
  ).getAllByRole("link")[0];
  expect(first?.getAttribute("href")).toMatch(/^\/dashboard\/containers\//);
});

it("says Docker isn't reachable instead of loading forever", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["docker-11"],
  });
  const real = await transport.dockerSnapshot();
  if (real.status !== "ok") throw new Error("snapshot failed");
  vi.spyOn(transport, "dockerSnapshot").mockResolvedValue({
    status: "ok",
    data: { ...real.data, status: "unavailable", engine: null },
  });
  setup(transport);
  expect(await screen.findByText(/Docker isn't reachable/)).toBeVisible();
  expect(screen.getByText("Unavailable")).toBeVisible();
  expect(screen.queryByText(/Loading/)).toBeNull();
});
