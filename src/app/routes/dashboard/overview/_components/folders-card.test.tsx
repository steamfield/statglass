import { formatBytes } from "@core/format";
import { MOCK_SCAN_MS } from "@core/mock/disk-space";
import { MOCK_HIGHLIGHTS } from "@core/mock/disk-space-fixture";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { OverviewFoldersCard, splitPath } from "./folders-card";

function setup(scenarios: ScenarioName[] = [], now = () => Date.now()) {
  const transport = createMockTransport({ autoTick: false, scenarios, now });
  const reveal = vi.spyOn(transport, "diskSpaceRevealHighlight");
  renderWithProviders(<OverviewFoldersCard origin="tl" />, {
    transport,
    route: "/dashboard/overview",
  });
  return { reveal, transport };
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
  expect(screen.getByRole("button", { name: "Re-run" })).toBeVisible();
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

it("runs the first report only when asked, then shows its folders", async () => {
  let clock = Date.now();
  const { transport } = setup(["disk-space-unscanned"], () => clock);
  const start = vi.spyOn(transport, "diskSpaceStart");
  const run = await screen.findByRole("button", { name: "Run report" });
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(run);
  expect(
    await screen.findByText(/Scanning this Mac's disk… \d+%/)
  ).toBeVisible();
  expect(start).toHaveBeenCalledWith(expect.anything(), "/", []);
  clock += MOCK_SCAN_MS;
  const list = await screen.findByRole(
    "list",
    { name: "Largest folders" },
    { timeout: 3000 }
  );
  expect(within(list).getAllByRole("button")).toHaveLength(5);
  expect(screen.getByText("Scanned just now")).toBeVisible();
});

it("keeps the last report and offers to run it again", async () => {
  const { transport } = setup();
  const start = vi.spyOn(transport, "diskSpaceStart");
  await screen.findByText("Scanned 3 days ago");
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.anything(), "/", [])
  );
  expect(await screen.findByText(/Scanning this Mac's disk/)).toBeVisible();
});

it("names a folder and its parent from this user's home only", () => {
  expect(splitPath("/Users/riley/Library/Caches", "/Users/riley")).toEqual({
    name: "Caches",
    parent: "~/Library",
  });
  expect(splitPath("/Users/riley/Downloads", "/Users/riley")).toEqual({
    name: "Downloads",
    parent: "~",
  });
  expect(splitPath("/Users/alice/Downloads", "/Users/riley")).toEqual({
    name: "Downloads",
    parent: "/Users/alice",
  });
  expect(splitPath("/Users/rileyx/Movies", "/Users/riley").parent).toBe(
    "/Users/rileyx"
  );
  expect(splitPath("/Applications", null)).toEqual({
    name: "Applications",
    parent: "/",
  });
});

it("says why Finder couldn't show a folder", async () => {
  const { reveal } = setup();
  reveal.mockResolvedValue({
    status: "error",
    error: { kind: "disk_space", message: "This item no longer exists" },
  });
  const list = await screen.findByRole("list", { name: "Largest folders" });
  fireEvent.click(within(list).getByRole("button", { name: /^Downloads/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This item no longer exists"
  );
});
