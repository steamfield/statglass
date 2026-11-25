import { MOCK_SCAN_MS } from "@core/mock/disk-space";
import { MOCK_HIGHLIGHTS } from "@core/mock/disk-space-fixture";
import { MOCK_HOST_ID, type ScenarioName } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { diskSpaceKeys, hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { createTestQueryClient, renderWithProviders } from "@tests/test-utils";
import { Profiler, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HostSelectionContext } from "~/lib/host-selection";
import { HostStoreProvider } from "~/stores/host-store";
import DiskSpaceRoute from "./route";

// A scan polls once a second; give a poll room to land.
const POLL = { timeout: 3000 };

function scanTest(name: string, run: () => Promise<void>) {
  it(name, { timeout: 15_000 }, run);
}

function setup(route = "/", scenarios: ScenarioName[] = []) {
  let t = Date.now();
  const transport = createMockTransport({
    now: () => t,
    autoTick: false,
    scenarios,
  });
  const result = renderWithProviders(<DiskSpaceRoute />, { transport, route });
  return {
    ...result,
    /** Moves the mock scan's clock; the next poll sees it. */
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const contents = () => screen.getByRole("table", { name: "Folder contents" });
const row = (name: string | RegExp) =>
  within(contents()).getByRole("row", { name });
const search = (r: ReturnType<typeof setup>) =>
  new URLSearchParams(r.router.state.location.search);

async function scanBoot(r: ReturnType<typeof setup>) {
  await r.user.click(
    await screen.findByRole("button", { name: "Scan Macintosh HD" })
  );
  await screen.findByText(/Scanning · about/);
}

async function finish(r: ReturnType<typeof setup>) {
  r.advance(MOCK_SCAN_MS);
  await screen.findByRole("button", { name: "Scan again" }, POLL);
}

describe("Disk space landing", () => {
  scanTest(
    "shows every kept folder and rescans the boot volume with the selected includes",
    async () => {
      const r = setup();
      const { user } = r;

      const card = await screen.findByRole("region", {
        name: "Largest folders",
      });
      expect(within(card).getByText("Scanned 3 days ago")).toBeVisible();
      expect(
        within(card).getByText(
          "From the last scan of Macintosh HD. Scanning again rebuilds the full breakdown."
        )
      ).toBeVisible();
      const list = within(card).getByRole("list", { name: "Largest folders" });
      expect(
        within(list)
          .getAllByRole("button")
          .map((row) => row.title)
      ).toEqual(MOCK_HIGHLIGHTS.folders.map((folder) => folder.path));
      expect(
        screen.getByRole("button", { name: "Scan Macintosh HD" })
      ).toHaveAttribute("data-variant", "outline");
      expect(
        screen.getByRole("button", { name: "Scan SanDisk Extreme" })
      ).toHaveAttribute("data-variant", "outline");
      expect(
        within(card).getByRole("button", { name: "Scan again" })
      ).toHaveAttribute("data-variant", "default");

      await user.click(
        screen.getByText("Protected locations · 7 of 7 skipped")
      );
      await user.click(screen.getByRole("checkbox", { name: "Downloads" }));
      await user.click(screen.getByRole("button", { name: "Scan again" }));
      await screen.findByText(/Scanning · about/);
      expect(
        screen.queryByRole("region", { name: "Largest folders" })
      ).toBeNull();

      r.advance(MOCK_SCAN_MS);
      expect(
        await screen.findByText(/6 locations protected by macOS/, {}, POLL)
      ).toBeVisible();
      expect(
        screen.getByRole("heading", { name: "In Macintosh HD" })
      ).toBeVisible();
      await user.click(screen.getByText("Skipped folders"));
      expect(screen.getByText(/Protected by macOS:/)).not.toHaveTextContent(
        "Downloads"
      );
    }
  );

  it("shows the summary and keeps every picker scan secondary on a boot link", async () => {
    setup("/?vol=/");
    expect(
      await screen.findByRole("region", { name: "Largest folders" })
    ).toBeVisible();
    const picker = screen.getByRole("region", { name: "Volumes to scan" });
    const scans = within(picker).getAllByRole("button", { name: /^Scan / });
    expect(scans).toHaveLength(2);
    for (const scan of scans)
      expect(scan).toHaveAttribute("data-variant", "outline");
  });

  it("makes the retained boot report the primary action with one Scan again", async () => {
    const r = renderWithProviders(<DiskSpaceRoute />, {
      transportOptions: { spaceScan: "/" },
    });
    const open = await screen.findByRole("button", { name: "Open report" });
    expect(open).toHaveAttribute("data-variant", "default");
    expect(
      screen.queryByRole("region", { name: "Largest folders" })
    ).toBeNull();
    expect(screen.getAllByText("Scan again")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Scan Macintosh HD" })
    ).toHaveAttribute("data-variant", "outline");
    expect(
      screen.getByRole("button", { name: "Scan SanDisk Extreme" })
    ).toHaveAttribute("data-variant", "outline");
    await r.user.click(open);
    expect(
      await screen.findByRole("heading", { name: "In Macintosh HD" })
    ).toBeVisible();
  });

  it("makes the boot scan primary when there is no kept summary", async () => {
    setup("/", ["disk-space-unscanned"]);
    expect(
      await screen.findByRole("heading", { name: "Choose a volume" })
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Largest folders" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Scan Macintosh HD" })
    ).toHaveAttribute("data-variant", "default");
    expect(
      screen.getByRole("button", { name: "Scan SanDisk Extreme" })
    ).toHaveAttribute("data-variant", "outline");
  });

  it("makes the linked external volume primary and hides the boot summary", async () => {
    setup("/?vol=/Volumes/SanDisk%20Extreme");
    expect(
      await screen.findByRole("button", { name: "Scan SanDisk Extreme" })
    ).toHaveAttribute("data-variant", "default");
    expect(
      screen.getByRole("button", { name: "Scan Macintosh HD" })
    ).toHaveAttribute("data-variant", "outline");
    expect(
      screen.queryByRole("region", { name: "Largest folders" })
    ).toBeNull();
  });

  it("leads with the linked external volume even while a boot report is kept", async () => {
    renderWithProviders(<DiskSpaceRoute />, {
      route: "/?vol=/Volumes/SanDisk%20Extreme",
      transportOptions: { spaceScan: "/" },
    });
    expect(
      await screen.findByRole("button", { name: "Open report" })
    ).not.toHaveAttribute("data-variant", "default");
    expect(
      screen.getByRole("button", { name: "Scan SanDisk Extreme" })
    ).toHaveAttribute("data-variant", "default");
  });
});

describe("Disk space landing states", () => {
  it.each([
    { name: "the first visit", route: "/", cachedMiss: false },
    { name: "a cached miss", route: "/", cachedMiss: true },
    {
      name: "a cached miss on an external link",
      route: "/?vol=/Volumes/SanDisk%20Extreme",
      cachedMiss: true,
    },
  ])(
    "keeps the landing loading until highlights settle after $name",
    async ({ route, cachedMiss }) => {
      const transport = createMockTransport({ autoTick: false });
      const queryClient = createTestQueryClient();
      queryClient.setQueryData(
        diskSpaceKeys.volumes(MOCK_HOST_ID),
        await unwrap(transport.diskSpaceVolumes(MOCK_HOST_ID))
      );
      if (cachedMiss)
        queryClient.setQueryData(diskSpaceKeys.highlights(MOCK_HOST_ID), null);

      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const highlights = transport.diskSpaceHighlights;
      transport.diskSpaceHighlights = async (host) => {
        await held;
        return highlights(host);
      };
      try {
        renderWithProviders(<DiskSpaceRoute />, {
          transport,
          queryClient,
          route,
        });
        expect(screen.getByText("Loading volumes…")).toBeVisible();
        expect(
          screen.queryByRole("region", { name: "Volumes to scan" })
        ).toBeNull();
        expect(
          screen.queryByRole("region", { name: "Largest folders" })
        ).toBeNull();
      } finally {
        release();
      }
      expect(
        await screen.findByRole("region", { name: "Volumes to scan" })
      ).toBeVisible();
      expect(screen.queryByText("Loading volumes…")).toBeNull();
      if (route === "/") {
        expect(
          screen.getByRole("region", { name: "Largest folders" })
        ).toBeVisible();
      } else {
        expect(
          screen.getByRole("button", { name: "Scan SanDisk Extreme" })
        ).toHaveAttribute("data-variant", "default");
      }
    }
  );

  scanTest(
    "preserves the open picker and its focus while a finished scan refreshes highlights",
    async () => {
      const r = setup();
      await scanBoot(r);
      await r.user.click(
        within(
          screen.getByRole("navigation", { name: "Folder path" })
        ).getByRole("button", { name: "Volumes" })
      );
      await r.user.click(
        await screen.findByText("Protected locations · 7 of 7 skipped")
      );
      expect(screen.getByRole("button", { name: "Scan again" })).toBeDisabled();
      await r.user.click(screen.getByRole("checkbox", { name: "Downloads" }));
      expect(screen.getByRole("checkbox", { name: "Downloads" })).toHaveFocus();

      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const highlights = r.transport.diskSpaceHighlights;
      vi.spyOn(r.transport, "diskSpaceHighlights").mockImplementation(
        async (host) => {
          await held;
          return highlights(host);
        }
      );
      try {
        r.advance(MOCK_SCAN_MS);
        expect(
          await screen.findByRole("button", { name: "Open report" }, POLL)
        ).toBeVisible();
        expect(
          screen.getByRole("checkbox", { name: "Downloads" })
        ).toHaveFocus();
        expect(
          screen.getByRole("checkbox", { name: "Downloads" })
        ).toBeChecked();
      } finally {
        release();
      }
    }
  );

  scanTest(
    "keeps the picker visible on return from a report while highlights refresh",
    async () => {
      const r = setup();
      await scanBoot(r);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const highlights = r.transport.diskSpaceHighlights;
      vi.spyOn(r.transport, "diskSpaceHighlights").mockImplementation(
        async (host) => {
          await held;
          return highlights(host);
        }
      );
      try {
        await finish(r);
        await waitFor(() =>
          expect(
            r.queryClient.isFetching({
              queryKey: diskSpaceKeys.highlights(MOCK_HOST_ID),
            })
          ).toBe(1)
        );
        await r.user.click(
          within(
            screen.getByRole("navigation", { name: "Folder path" })
          ).getByRole("button", { name: "Volumes" })
        );
        expect(
          screen.getByRole("region", { name: "Volumes to scan" })
        ).toBeVisible();
        expect(screen.queryByText("Loading volumes…")).toBeNull();
      } finally {
        release();
      }
    }
  );

  it("keeps a shown summary when refreshing it fails", async () => {
    const r = setup();
    await screen.findByRole("region", { name: "Largest folders" });
    vi.spyOn(r.transport, "diskSpaceHighlights").mockResolvedValue({
      status: "error",
      error: { kind: "disk_space", message: "Couldn't refresh the last scan" },
    });
    const queryKey = diskSpaceKeys.highlights(MOCK_HOST_ID);
    await act(() => r.queryClient.invalidateQueries({ queryKey }));
    await waitFor(() =>
      expect(r.queryClient.getQueryState(queryKey)?.status).toBe("error")
    );
    expect(
      screen.getByRole("region", { name: "Largest folders" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeEnabled();
    expect(screen.queryByText("Couldn't refresh the last scan")).toBeNull();
  });

  it("quietly offers the boot scan when highlights fail to load", async () => {
    const transport = createMockTransport({ autoTick: false });
    vi.spyOn(transport, "diskSpaceHighlights").mockResolvedValue({
      status: "error",
      error: { kind: "disk_space", message: "Couldn't read the last scan" },
    });
    renderWithProviders(<DiskSpaceRoute />, { transport });

    expect(
      await screen.findByRole("button", { name: "Scan Macintosh HD" })
    ).toHaveAttribute("data-variant", "default");
    expect(
      screen.queryByRole("region", { name: "Largest folders" })
    ).toBeNull();
    expect(screen.queryByText(/Couldn't read the last scan/)).toBeNull();
  });

  it("offers the boot scan when the kept summary has no folders", async () => {
    const transport = createMockTransport({ autoTick: false });
    vi.spyOn(transport, "diskSpaceHighlights").mockResolvedValue({
      status: "ok",
      data: { ...MOCK_HIGHLIGHTS, folders: [] },
    });
    renderWithProviders(<DiskSpaceRoute />, { transport });

    expect(
      await screen.findByRole("button", { name: "Scan Macintosh HD" })
    ).toHaveAttribute("data-variant", "default");
    expect(
      screen.queryByRole("region", { name: "Largest folders" })
    ).toBeNull();
  });

  it("says why Finder couldn't reveal a folder from the kept summary", async () => {
    const transport = createMockTransport({ autoTick: false });
    vi.spyOn(transport, "diskSpaceRevealHighlight").mockResolvedValue({
      status: "error",
      error: { kind: "disk_space", message: "This item no longer exists" },
    });
    const { user } = renderWithProviders(<DiskSpaceRoute />, { transport });
    const card = await screen.findByRole("region", { name: "Largest folders" });
    await user.click(within(card).getByRole("button", { name: /^Downloads/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This item no longer exists"
    );
  });

  it("shows an inline error when Finder's command rejects", async () => {
    const transport = createMockTransport({ autoTick: false });
    vi.spyOn(transport, "diskSpaceRevealHighlight").mockRejectedValue(
      new Error("Finder could not be reached")
    );
    const { user } = renderWithProviders(<DiskSpaceRoute />, { transport });
    await user.click(await screen.findByRole("button", { name: /^Downloads/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finder could not be reached"
    );
  });

  it("shows the edition message and no summary in the App Store edition", async () => {
    setup("/", ["appstore"]);
    expect(
      await screen.findByText(
        "Space reports are not available in this edition."
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Largest folders" })
    ).toBeNull();
  });
});

describe("Disk space", () => {
  scanTest(
    "fills the report in while scanning, then shows the finished breakdown",
    async () => {
      const r = setup();
      await scanBoot(r);
      expect(search(r).get("vol")).toBe("/");
      // Top-level folders are listed at once: a running one with what it has
      // so far, one the scan has not reached yet as waiting.
      expect(row(/^Users, scanning/)).toHaveTextContent(/MB so far/);
      expect(row(/^Applications, scanning, Waiting/)).toHaveTextContent(
        "Waiting"
      );
      expect(
        screen.getByRole("radio", { name: "Largest files" })
      ).toBeDisabled();
      await finish(r);
      // The finished tree replaces the last in-progress poll.
      await waitFor(() =>
        expect(within(contents()).queryByText(/so far|Waiting/)).toBeNull()
      );
      expect(row(/^Other/)).toBeVisible();
      expect(row(/^Users, 234 GB, folder/)).toHaveTextContent("1,434");
      expect(
        screen.getByRole("img", { name: /^Treemap of Macintosh HD/ })
      ).toBeVisible();
      expect(screen.queryByText(/Scanning · about/)).toBeNull();
      expect(
        screen.getByText(/7 locations protected by macOS and 312 folders/)
      ).toBeVisible();
      await r.user.click(screen.getByText("Skipped folders"));
      expect(screen.getByText(/Protected by macOS: Desktop/)).toBeVisible();
    }
  );

  scanTest("does not open a folder that is still scanning", async () => {
    const r = setup();
    await scanBoot(r);
    act(() => row(/^Users, scanning/).focus());
    await r.user.keyboard("{Enter}");
    expect(
      screen.getByRole("navigation", { name: "Folder path" })
    ).not.toHaveTextContent("Users");
  });

  scanTest(
    "drills down and back up with Finder's keys and the breadcrumb",
    async () => {
      const r = setup();
      await scanBoot(r);
      await finish(r);
      const path = () =>
        screen.getByRole("navigation", { name: "Folder path" });
      act(() => row(/^Users, /).focus());
      await r.user.keyboard("{Enter}");
      await waitFor(() =>
        expect(path()).toHaveTextContent(/Macintosh HDUsers$/)
      );
      act(() => row(/^riley, /).focus());
      await r.user.keyboard("{Meta>}{ArrowDown}{/Meta}");
      await waitFor(() => expect(path()).toHaveTextContent(/Usersriley$/));
      expect(row(/^Projects, /)).toBeVisible();
      act(() => row(/^Projects, /).focus());
      await r.user.keyboard("{Meta>}{ArrowUp}{/Meta}");
      await waitFor(() => expect(path()).not.toHaveTextContent("riley"));
      act(() => row(/^riley, /).focus());
      await r.user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "In Macintosh HD" })
        ).toBeVisible()
      );
      await r.user.click(
        within(path()).getByRole("button", { name: "Volumes" })
      );
      expect(
        await screen.findByRole("button", { name: "Open report" })
      ).toBeVisible();
      expect(search(r).get("vol")).toBeNull();
      await r.user.click(screen.getByRole("button", { name: "Open report" }));
      expect(await screen.findByText("Used")).toBeVisible();
    }
  );

  scanTest("enters protected locations only when included", async () => {
    const r = setup();
    await r.user.click(
      await screen.findByText("Protected locations · 7 of 7 skipped")
    );
    await r.user.click(screen.getByRole("checkbox", { name: "Downloads" }));
    expect(
      screen.getByText("Protected locations · 6 of 7 skipped")
    ).toBeVisible();
    await scanBoot(r);
    await finish(r);
    expect(screen.getByText(/6 locations protected by macOS/)).toBeVisible();
    await r.user.click(screen.getByText("Skipped folders"));
    const note = screen.getByText(/Protected by macOS:/);
    expect(note).not.toHaveTextContent("Downloads");
    expect(note).toHaveTextContent("Documents");
  });

  scanTest(
    "lists the largest files and copies a path as Finder shows it",
    async () => {
      const r = setup();
      await scanBoot(r);
      await finish(r);
      await r.user.click(screen.getByRole("radio", { name: "Largest files" }));
      const table = await screen.findByRole("table", { name: "Largest files" });
      const first = within(table).getAllByRole("row")[1] as HTMLElement;
      expect(first).toHaveTextContent("census.parquet");
      expect(first).toHaveTextContent("Users/riley/Projects/opendata/data");
      await r.user.click(
        within(first).getByRole("button", {
          name: "Copy the path of census.parquet",
        })
      );
      await waitFor(async () =>
        expect(await navigator.clipboard.readText()).toBe(
          "/Users/riley/Projects/opendata/data/census.parquet"
        )
      );
      expect(
        screen.getByText(
          "Copied /Users/riley/Projects/opendata/data/census.parquet"
        )
      ).toBeVisible();
    }
  );

  scanTest(
    "marks the volume being scanned and leads back to its scan",
    async () => {
      const r = setup();
      await scanBoot(r);
      const path = screen.getByRole("navigation", { name: "Folder path" });
      await r.user.click(within(path).getByRole("button", { name: "Volumes" }));
      // Another volume can't start while this one runs.
      expect(
        await screen.findByRole("button", { name: "Scan SanDisk Extreme" })
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "Scan Macintosh HD" })
      ).toBeNull();
      await r.user.click(
        screen.getByRole("button", { name: "Show the scan of Macintosh HD" })
      );
      expect(await screen.findByText(/Scanning · about/)).toBeVisible();
      expect(search(r).get("vol")).toBe("/");
    }
  );

  scanTest("keeps the previous report when a rescan is cancelled", async () => {
    const r = setup();
    await scanBoot(r);
    await finish(r);
    await r.user.click(screen.getByRole("button", { name: "Scan again" }));
    await screen.findByText(/Scanning · about/);
    await r.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText(
        "The last scan was cancelled before it finished. The previous report is shown."
      )
    ).toBeVisible();
    expect(screen.getByText("Used")).toBeVisible();
  });

  scanTest("says why a scan failed when its volume disconnects", async () => {
    const r = setup("/", ["disk-space-eject"]);
    await r.user.click(
      await screen.findByRole("button", { name: "Scan SanDisk Extreme" })
    );
    await screen.findByText(/Scanning · about/);
    r.advance(MOCK_SCAN_MS);
    expect(
      await screen.findByText(
        "Couldn't finish scanning SanDisk Extreme: the volume was disconnected.",
        {},
        POLL
      )
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Volumes to scan" })
    ).toBeVisible();
  });
});

describe("Disk space outside a local scan", () => {
  scanTest(
    "does not re-render a finished report on the 1 Hz tick",
    async () => {
      let commits = 0;
      let t = 1_700_000_000_000;
      const transport = createMockTransport({ now: () => t, autoTick: false });
      const r = renderWithProviders(
        <Profiler id="space" onRender={() => commits++}>
          <DiskSpaceRoute />
        </Profiler>,
        { transport, route: "/" }
      );
      await r.user.click(
        await screen.findByRole("button", { name: "Scan Macintosh HD" })
      );
      t += MOCK_SCAN_MS;
      await screen.findByRole("button", { name: "Scan again" }, POLL);
      await waitFor(() =>
        expect(within(contents()).queryByText("Scanning…")).toBeNull()
      );
      const before = commits;
      act(() => {
        for (let i = 0; i < 3; i++) transport.tick();
      });
      expect(commits).toBe(before);
    }
  );
});

/** Disk › Space on the `linux-host` peer, linux-tailscale (D-117). */
function remoteSetup() {
  let t = 1_700_000_000_000;
  const transport = createMockTransport({
    now: () => t,
    autoTick: false,
    scenarios: ["linux-host"],
  });
  const result = renderWithProviders(
    <HostStoreProvider hostId="remote-linux">
      <DiskSpaceRoute />
    </HostStoreProvider>,
    { transport, route: "/" }
  );
  return {
    ...result,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("Disk › Space on a remote Linux host (D-117)", () => {
  scanTest(
    "scans the host's mounts and copies its paths, with no Reveal in Finder",
    async () => {
      const r = remoteSetup();
      const volumes = await screen.findByRole("region", {
        name: "Volumes to scan",
      });
      for (const mount of ["/", "/boot", "/boot/efi"])
        expect(
          within(volumes).getByRole("button", { name: `Scan ${mount}` })
        ).toBeEnabled();
      // Nothing on Linux is protected the way macOS protects folders.
      expect(screen.queryByText(/Protected locations/)).toBeNull();
      expect(screen.queryByText(/macOS/)).toBeNull();
      await r.user.click(screen.getByRole("button", { name: "Scan /" }));
      await screen.findByText(/Scanning · about/);
      r.advance(MOCK_SCAN_MS);
      await screen.findByRole("button", { name: "Scan again" }, POLL);
      expect(screen.getByText("/ · 141 GB of 155 GB used")).toBeVisible();
      expect(
        screen.getByText(
          /no file accounts for: snapshots and filesystem metadata\./
        )
      ).toBeVisible();
      const path = () =>
        screen.getByRole("navigation", { name: "Folder path" });
      act(() => row(/^var, /).focus());
      await r.user.keyboard("{Enter}");
      await waitFor(() => expect(path()).toHaveTextContent(/\/var$/));
      expect(screen.queryByRole("button", { name: /in Finder$/ })).toBeNull();
      await r.user.click(
        within(row(/^lib, /)).getByRole("button", {
          name: "Copy the path of lib",
        })
      );
      await waitFor(async () =>
        expect(await navigator.clipboard.readText()).toBe("/var/lib")
      );
      // The host's scan is its own: this Mac's stays idle.
      const local = await r.transport.diskSpaceStatus(MOCK_HOST_ID);
      expect(local.status === "ok" && local.data.phase).toBe("idle");
    }
  );

  it("says when the host's StatGlass is too old to answer", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["linux-host"],
    });
    const old = {
      status: "error",
      error: {
        kind: "remote_incompatible",
        message: "this host's StatGlass is too old to answer; update it",
      },
    } as const;
    transport.diskSpaceVolumes = async () => old;
    transport.diskSpaceStatus = async () => old;
    renderWithProviders(
      <HostStoreProvider hostId="remote-linux">
        <DiskSpaceRoute />
      </HostStoreProvider>,
      { transport, route: "/" }
    );
    expect(
      await screen.findByText(
        "This host's StatGlass is too old to share space reports. Update StatGlass on it, then try again."
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Volumes to scan" })
    ).toBeNull();
  });

  it("says when the host is not connected", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["linux-host"],
    });
    const [linux] = await transport.listRemoteHosts();
    if (!linux) throw new Error("no remote host");
    await transport.updateRemoteHost({ ...linux.config, enabled: false });
    renderWithProviders(
      <HostStoreProvider hostId="remote-linux">
        <DiskSpaceRoute />
      </HostStoreProvider>,
      { transport, route: "/" }
    );
    expect(
      await screen.findByText(
        "This host isn't connected, so its space reports can't be read now."
      )
    ).toBeVisible();
  });

  scanTest(
    "says the report was dropped when the connection to the host ended",
    async () => {
      const r = remoteSetup();
      await r.user.click(await screen.findByRole("button", { name: "Scan /" }));
      r.advance(MOCK_SCAN_MS);
      await screen.findByRole("button", { name: "Scan again" }, POLL);
      const [linux] = await r.transport.listRemoteHosts();
      if (!linux) throw new Error("no remote host");
      // The session ends: the host drops its report, and the view hears of
      // the connection change on its next read of the host list.
      const reconnect = async (enabled: boolean) => {
        await r.transport.updateRemoteHost({ ...linux.config, enabled });
        await act(() =>
          r.queryClient.invalidateQueries({ queryKey: hostKeys.remote() })
        );
      };
      await reconnect(false);
      expect(
        await screen.findByText(
          "This host isn't connected, so its space reports can't be read now."
        )
      ).toBeVisible();
      await reconnect(true);
      expect(
        await screen.findByText(
          "The report was dropped when the connection to linux-tailscale ended."
        )
      ).toBeVisible();
      expect(
        screen.getByRole("region", { name: "Volumes to scan" })
      ).toBeVisible();
    }
  );

  scanTest(
    "says the report was dropped when a folder of it no longer loads",
    async () => {
      const r = remoteSetup();
      await r.user.click(await screen.findByRole("button", { name: "Scan /" }));
      r.advance(MOCK_SCAN_MS);
      await screen.findByRole("button", { name: "Scan again" }, POLL);
      // A reconnect too quick for the host list to show it.
      const [linux] = await r.transport.listRemoteHosts();
      if (!linux) throw new Error("no remote host");
      await r.transport.updateRemoteHost({ ...linux.config, enabled: false });
      await r.transport.updateRemoteHost({ ...linux.config, enabled: true });
      act(() => row(/^var, /).focus());
      await r.user.keyboard("{Enter}");
      expect(
        await screen.findByText(
          "The report was dropped when the connection to linux-tailscale ended."
        )
      ).toBeVisible();
      expect(screen.queryByText(/Couldn't load this folder/)).toBeNull();
    }
  );

  it("starts over on the other host's own volumes when switching hosts", async () => {
    const transport = createMockTransport({
      scenarios: ["linux-host"],
      autoTick: false,
    });
    const hosts = await transport.listHosts();
    function Harness() {
      const [selected, select] = useState<string>("remote-linux");
      return (
        <HostSelectionContext value={{ hosts, selected, select }}>
          <HostStoreProvider hostId={selected}>
            <DiskSpaceRoute />
          </HostStoreProvider>
          <button type="button" onClick={() => select(MOCK_HOST_ID)}>
            This Mac
          </button>
        </HostSelectionContext>
      );
    }
    const r = renderWithProviders(<Harness />, {
      transport,
      route: "/",
    });
    expect(
      await screen.findByRole("button", { name: "Scan /boot" })
    ).toBeVisible();
    await r.user.click(screen.getByRole("button", { name: "This Mac" }));
    expect(
      await screen.findByRole("button", { name: "Scan Macintosh HD" })
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Scan /boot" })).toBeNull();
  });
});
