import type { ScenarioName } from "@core/mock/fixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useRoutes } from "react-router";
import DiskSpaceRoute from "../disk-space/route";
import DiskRoute from "./route";

const DISK = "/dashboard/disk";
const SPACE = "/dashboard/disk-space";
const BOOT_ACTION = "See what's using space on Macintosh HD";
const SPACE_ACTION = /^See what's using space/;

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
    /12 GB free · See what's using space$/
  );
  expect(link.closest("td")).toHaveAccessibleName(
    /^Low disk space\. 12 GB free\b/
  );
  const data = screen.getByRole("row", { name: /^\/System\/Volumes\/Data / });
  expect(within(data).getByText("20.0 GB")).toBeVisible();
  expect(within(data).queryByText(/GB free$/)).toBeNull();
  expect(within(data).queryByRole("button")).toBeNull();
});

it.each([
  ["normal capacity", [], "612 GB"],
  ["low space", ["disk-low-space"] satisfies ScenarioName[], "12 GB free"],
])(
  "shows %s but no Disk space action in the App Store edition",
  async (_label, scenarios, free) => {
    renderDisk(["appstore", ...scenarios]);
    const boot = await screen.findByRole("row", { name: /^\/ / });
    expect(within(boot).getByText(free)).toBeVisible();
    const capacity = screen.getByRole("region", { name: "Volume capacity" });
    expect(
      within(capacity).queryByRole("button", { name: SPACE_ACTION })
    ).toBeNull();
  }
);
