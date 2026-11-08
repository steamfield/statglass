import { formatBytes } from "@core/format";
import { MOCK_HIGHLIGHTS } from "@core/mock/disk-space-fixture";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { OverviewFoldersCard, splitPath } from "./folders-card";

function setup(scenarios: ScenarioName[] = []) {
  const transport = createMockTransport({ autoTick: false, scenarios });
  const reveal = vi.spyOn(transport, "diskSpaceRevealHighlight");
  renderWithProviders(<OverviewFoldersCard origin="tl" />, {
    transport,
    route: "/dashboard/overview",
  });
  return { reveal };
}

it("lists the five largest folders of the last scan, known ones by what they hold", async () => {
  setup();
  const list = await screen.findByRole("list", { name: "Largest folders" });
  const rows = within(list).getAllByRole("button");
  expect(rows).toHaveLength(5);
  expect(rows[0]?.textContent).toBe(
    `Containers~/Library${formatBytes(MOCK_HIGHLIGHTS.folders[0]?.bytes ?? 0)}`
  );
  expect(rows[3]?.textContent).toMatch(/^CoreSimulatoriOS simulators/);
  expect(rows[4]?.textContent).toMatch(/^Downloads~\d/);
  expect(screen.getByText("Scanned 3 days ago")).toBeVisible();
});

it("shows a row's folder in Finder by its path", async () => {
  const { reveal } = setup();
  const list = await screen.findByRole("list", { name: "Largest folders" });
  fireEvent.click(within(list).getByRole("button", { name: /^Downloads/ }));
  await waitFor(() =>
    expect(reveal).toHaveBeenCalledWith("/Users/riley/Downloads")
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("asks for a first scan when none is kept", async () => {
  setup(["disk-space-unscanned"]);
  expect(
    await screen.findByRole("link", { name: "Scan this Mac's disk" })
  ).toHaveAttribute("href", "/dashboard/disk?view=space&vol=/");
  expect(screen.queryByText(/Scanned/)).toBeNull();
});

it("names a folder and its parent from home", () => {
  expect(splitPath("/Users/riley/Library/Caches")).toEqual({
    name: "Caches",
    parent: "~/Library",
  });
  expect(splitPath("/Applications")).toEqual({
    name: "Applications",
    parent: "/",
  });
});
