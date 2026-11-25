import { MOCK_SCAN_MS } from "@core/mock/disk-space";
import { act, screen, within } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { expect, it } from "vitest";
import { useSpaceScan } from "~/hooks/use-disk-space";
import { useEdition } from "~/hooks/use-edition";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { LiveSidebar } from "./live-sidebar";

function EditionReadout() {
  return useEdition()?.disk_space === false ? (
    <p>Disk space unavailable in this edition</p>
  ) : null;
}

function StartScan() {
  const { start } = useSpaceScan();
  return (
    <button type="button" onClick={() => void start("/", [])}>
      Start scan
    </button>
  );
}

it("lists Disk space under Utilities and selects it after navigation", async () => {
  const { user } = renderWithProviders(<LiveSidebar />, {
    route: "/dashboard/settings",
  });

  const utilities = await screen.findByRole("list", { name: "Utilities" });
  expect(
    within(utilities).getByRole("link", { name: "Disk space" })
  ).toHaveAttribute("href", "/dashboard/disk-space");
  const nav = screen.getByRole("navigation", { name: "Dashboard sections" });
  expect(
    within(nav)
      .getAllByRole("link")
      .slice(-2)
      .map((link) => link.getAttribute("href"))
  ).toEqual(["/dashboard/settings", "/dashboard/disk-space"]);
  await user.click(within(utilities).getByRole("link", { name: "Disk space" }));
  expect(screen.getByRole("link", { name: "Disk space" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

it("omits Disk space and its group in the App Store edition", async () => {
  renderWithProviders(
    <>
      <LiveSidebar />
      <EditionReadout />
    </>,
    { transportOptions: { scenarios: ["appstore"] } }
  );

  await screen.findByText("Disk space unavailable in this edition");
  expect(
    screen.queryByRole("link", { name: "Disk space" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("list", { name: "Utilities" })
  ).not.toBeInTheDocument();
});

it("marks Disk space while a scan runs and clears the mark when it finishes", async () => {
  let now = 1_700_000_000_000;
  const { user } = renderWithProviders(
    <>
      <LiveSidebar />
      <StartScan />
    </>,
    {
      route: "/dashboard/settings",
      transportOptions: { now: () => now },
    }
  );

  await screen.findByRole("link", { name: "Disk space" });
  await user.click(screen.getByRole("button", { name: "Start scan" }));
  expect(
    await screen.findByRole("link", { name: /, Scan running$/ })
  ).toBeVisible();

  now += MOCK_SCAN_MS;
  // The running scan polls once a second.
  expect(
    await screen.findByRole("link", { name: "Disk space" }, { timeout: 3000 })
  ).toBeVisible();
});

it("keeps the busy Utilities group from re-rendering on live CPU frames", async () => {
  let hostStore: HostStore | undefined;
  function CaptureStore() {
    hostStore = useHostStore();
    return null;
  }

  const commits: string[] = [];
  const { transport, user } = renderWithProviders(
    <>
      <CaptureStore />
      <LiveSidebar onGroupRender={(id) => commits.push(id)} />
      <StartScan />
    </>,
    {
      route: "/dashboard/settings",
      transportOptions: { now: () => 1_700_000_000_000 },
    }
  );

  await screen.findByRole("link", { name: /^CPU \d/ });
  await user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("link", { name: /, Scan running$/ });
  expect(commits).toContain("utilities");

  if (!hostStore) throw new Error("Missing live store");
  for (const cpu of [61, 62, 63]) {
    commits.length = 0;
    const frame = nextFrame(hostStore.getState(), { "cpu.total": cpu });
    await act(async () => transport.push(frame));
    expect(screen.getByRole("link", { name: `CPU ${cpu}%` })).toBeVisible();
    expect(commits).toContain("modules");
    expect(commits).not.toContain("utilities");
  }
});
