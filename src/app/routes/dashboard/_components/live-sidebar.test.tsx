import { MOCK_SCAN_MS } from "@core/mock/disk-space";
import { act, screen, within } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { expect, it } from "vitest";
import type { SidebarEntry } from "~/components/sidebar";
import { useSpaceScan } from "~/hooks/use-disk-space";
import { useEdition } from "~/hooks/use-edition";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { useCpu } from "~/stores/live-selectors";
import { LiveSidebar, useUtilityEntries } from "./live-sidebar";

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

it("keeps the busy Utilities entries the same across live CPU frames", async () => {
  let hostStore: HostStore | undefined;
  const seen: { cpu: number | null; entries: readonly SidebarEntry[] }[] = [];
  // Re-renders on every CPU frame, as LiveSidebar does.
  function Probe() {
    hostStore = useHostStore();
    const cpu = useCpu();
    seen.push({ cpu: cpu?.total ?? null, entries: useUtilityEntries() });
    return null;
  }

  const { transport, user } = renderWithProviders(
    <>
      <Probe />
      <LiveSidebar />
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
  const busy = seen.at(-1)?.entries;
  expect(busy?.[0]?.busy).toEqual({ label: "Scan running" });

  if (!hostStore) throw new Error("Missing live store");
  for (const cpu of [61, 62, 63]) {
    const frame = nextFrame(hostStore.getState(), { "cpu.total": cpu });
    await act(async () => transport.push(frame));
    expect(screen.getByRole("link", { name: `CPU ${cpu}%` })).toBeVisible();
  }
  const during = seen.filter((s) => s.cpu !== null && s.cpu >= 61);
  expect(during.length).toBeGreaterThanOrEqual(3);
  for (const s of during) expect(s.entries).toBe(busy);
});
