import { formatPercent } from "@core/format";
import { createMockTransport } from "@core/mock-transport";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { ChartRangeProvider } from "~/stores/chart-range";
import { OverviewContainersCard } from "./containers-card";

const WINDOW = 900_000;

function setup() {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["docker-11"],
  });
  const comparison = vi.spyOn(transport, "dockerComparison");
  renderWithProviders(
    <ChartRangeProvider>
      <OverviewContainersCard windowMs={WINDOW} origin="tl" />
    </ChartRangeProvider>,
    { transport, route: "/dashboard/overview" }
  );
  return { transport, comparison };
}

const rows = async () =>
  within(await screen.findByRole("list", { name: "Busiest containers" }))
    .getAllByRole("link")
    .map((row) => row.textContent);

it("ranks the five containers that peaked highest in the window, without series", async () => {
  const { transport, comparison } = setup();
  const listed = await rows();
  const request = comparison.mock.calls.at(-1)?.[0];
  expect(request).toMatchObject({ metric: "cpu", selected: [] });
  const page = await transport.dockerComparison(
    request as NonNullable<typeof request>
  );
  if (page.status !== "ok") throw new Error("comparison failed");
  expect(page.data.series).toEqual([]);
  expect(listed).toEqual(
    page.data.ranking
      .filter((row) => row.peak_cpu_pct !== null)
      .slice(0, 5)
      .map((row) => `${row.container.name}${formatPercent(row.peak_cpu_pct)}`)
  );
  expect(request && request.to_ms - request.from_ms).toBe(WINDOW);
  expect(screen.getByText("Peak CPU")).toBeVisible();
  expect(screen.getByText(/\d+ running/)).toBeVisible();
});

it("re-ranks by memory and links each row to its container", async () => {
  const { comparison } = setup();
  await rows();
  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  await waitFor(() =>
    expect(comparison.mock.calls.at(-1)?.[0].metric).toBe("memory")
  );
  await waitFor(async () => expect((await rows())[0]).toMatch(/[KMG]B$/));
  const first = within(
    screen.getByRole("list", { name: "Busiest containers" })
  ).getAllByRole("link")[0];
  expect(first?.getAttribute("href")).toMatch(/^\/dashboard\/containers\//);
});
