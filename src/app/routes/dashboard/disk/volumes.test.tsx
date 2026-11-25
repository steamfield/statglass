import type { ScenarioName } from "@core/mock/fixtures";
import { seriesKey } from "@core/series-key";
import { screen, waitFor, within } from "@testing-library/react";
import { pushLayout } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { useRoutes } from "react-router";
import DiskSpaceRoute from "../disk-space/route";
import DiskRoute from "./route";

const DISK = "/dashboard/disk";
const SPACE = "/dashboard/disk-space";
const BOOT_ACTION = "See what's using space on Macintosh HD";
const SPACE_ACTION = /^See what's using space/;
const EXTERNAL = "/Volumes/SanDisk Extreme";

function DiskPages() {
  return useRoutes([
    { path: DISK, element: <DiskRoute /> },
    { path: SPACE, element: <DiskSpaceRoute /> },
  ]);
}

function renderDisk(scenarios: ScenarioName[] = [], route = DISK) {
  return renderWithProviders(<DiskPages />, {
    route,
    transportOptions: { scenarios },
  });
}

it("puts the Volumes card immediately after Disk I/O and before Disk by app", async () => {
  renderDisk();
  await screen.findByRole("heading", { name: /^Disk by app/ });
  const headings = screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
  expect(headings).toEqual([
    "Disk I/O",
    "Volumes",
    expect.stringMatching(/^Disk by app/),
  ]);
});

it("opens Disk space for the volume named in the row action", async () => {
  const { router, user } = renderDisk();
  const action = await screen.findByRole("button", { name: BOOT_ACTION });
  expect(screen.getByRole("row", { name: /^\/ / })).toContainElement(action);
  await user.click(action);
  expect(router.state.location.pathname).toBe(SPACE);
  expect(
    Object.fromEntries(new URLSearchParams(router.state.location.search))
  ).toEqual({ vol: "/" });
});

it.each([
  ["with a volume", "&vol=/", "?vol=%2F"],
  ["without a volume", "", ""],
])("redirects an old Space URL %s", async (_label, search, expected) => {
  const { router } = renderDisk([], `${DISK}?view=space${search}`);
  await waitFor(() => expect(router.state.location.pathname).toBe(SPACE));
  expect(router.state.location.search).toBe(expected);
});

it("shows a low-space flag beside the action and omits it at the threshold", async () => {
  renderDisk(["disk-low-space"]);
  const link = await screen.findByRole("button", { name: BOOT_ACTION });
  expect(link.closest("td")).toHaveTextContent(
    /^Low space · See what's using space$/
  );
  expect(link.closest("td")).toHaveAccessibleName(
    "Low space See what's using space"
  );
  const boot = screen.getByRole("row", { name: /^\/ / });
  expect(within(boot).getByRole("cell", { name: "12.0 GB" })).toBeVisible();
  const data = screen.getByRole("row", { name: /^\/System\/Volumes\/Data / });
  expect(within(data).getByText("20.0 GB")).toBeVisible();
  expect(within(data).queryByText("Low space")).toBeNull();
  expect(within(data).queryByRole("button")).toBeNull();
});

it("omits the warning for a small non-boot volume and a boot volume without a free reading", async () => {
  const { transport } = renderDisk();
  await screen.findByRole("row", { name: /^\/ / });
  const push = pushLayout(transport, 99, [
    seriesKey("disk.used", { vol: "/" }),
    seriesKey("disk.total", { vol: "/" }),
    seriesKey("disk.free", { vol: "/" }),
    seriesKey("disk.total", { vol: EXTERNAL }),
    seriesKey("disk.free", { vol: EXTERNAL }),
  ]);
  push(Date.now() + 1000, [900e9, 1000e9, null, 16e9, 15e9]);

  const action = await screen.findByRole("button", {
    name: "See what's using space on SanDisk Extreme",
  });
  const externalRow = screen.getByRole("row", {
    name: /^\/Volumes\/SanDisk Extreme /,
  });
  expect(externalRow).toContainElement(action);
  expect(
    within(externalRow).getByRole("cell", { name: "15.0 GB" })
  ).toBeVisible();
  expect(action.closest("td")).toHaveTextContent(/^See what's using space$/);
  const boot = screen.getByRole("row", { name: /^\/ / });
  expect(within(boot).getByRole("cell", { name: "—" })).toBeVisible();
  expect(within(boot).queryByText("Low space")).toBeNull();
});

it("omits the Actions column when the rows have no scan target or warning", async () => {
  const { transport } = renderDisk(["disk-space-boot-only"]);
  await screen.findByRole("button", { name: BOOT_ACTION });
  const push = pushLayout(transport, 99, [
    seriesKey("disk.total", { vol: EXTERNAL }),
    seriesKey("disk.free", { vol: EXTERNAL }),
  ]);
  push(Date.now() + 1000, [64e9, 32e9]);
  await screen.findByRole("row", { name: /^\/Volumes\/SanDisk Extreme / });
  const capacity = screen.getByRole("region", { name: "Volume capacity" });
  expect(
    within(capacity).queryByRole("columnheader", { name: "Actions" })
  ).toBeNull();
});

it("omits the Actions column in the App Store edition with normal capacity", async () => {
  renderDisk(["appstore"]);
  await screen.findByRole("row", { name: /^\/ / });
  const capacity = screen.getByRole("region", { name: "Volume capacity" });
  expect(
    within(capacity).queryByRole("columnheader", { name: "Actions" })
  ).toBeNull();
});

it("shows the boot warning without a scan action in the App Store edition", async () => {
  renderDisk(["appstore", "disk-low-space"]);
  expect(await screen.findByRole("cell", { name: "Low space" })).toBeVisible();
  const boot = screen.getByRole("row", { name: /^\/ / });
  expect(within(boot).getByRole("cell", { name: "12.0 GB" })).toBeVisible();
  const capacity = screen.getByRole("region", { name: "Volume capacity" });
  expect(
    within(capacity).queryByRole("button", { name: SPACE_ACTION })
  ).toBeNull();
});
