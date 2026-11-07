import type { NetworkByApp } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  NETWORK_BY_APP_FROM_MS,
  networkByApp,
} from "@tests/fixtures/network-by-app";
import { renderWithProviders } from "@tests/test-utils";
import { createElement, Fragment } from "react";
import { BrushProvider, useBrushStore } from "~/stores/brush-store";
import { AppsCard } from "./apps-card";
import { AppsNowCard } from "./apps-now-card";

const T = NETWORK_BY_APP_FROM_MS;

const tableNames = () =>
  within(screen.getByRole("table", { name: "Network by app" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
const appNames = () => tableNames().slice(0, 3);
const header = (label: string) =>
  screen.getByRole("columnheader", { name: new RegExp(`^${label}`) });
const clickHeader = (label: string) =>
  fireEvent.click(within(header(label)).getByRole("button"));
function renderApps() {
  let totals = networkByApp({ other_apps_rx_bytes: 100 });
  let latest = networkByApp({
    apps: [{ name: "Google Chrome", rx_bytes: 11e6, tx_bytes: 0 }],
  });
  const transport = createMockTransport({
    now: () => T + 5000,
    autoTick: false,
  });
  transport.queryNetworkByApp = async (_host, from, to) => ({
    status: "ok",
    data: {
      ...(to - from > 10_000 ? totals : latest),
      from_ms: from,
      to_ms: to,
      complete_to_ms: to,
    },
  });
  const result = renderWithProviders(<AppsCard windowMs={300_000} />, {
    transport,
  });
  return {
    ...result,
    update: async (next: NetworkByApp, bucket: NetworkByApp) => {
      totals = next;
      latest = bucket;
      await act(async () => {
        await result.queryClient.invalidateQueries();
      });
    },
  };
}

describe("Network app identity", () => {
  it("breaks collating-equal app names by key across refreshed frames and directions", async () => {
    const result = renderApps();
    await screen.findByRole("table", { name: "Network by app" });
    const apps = [
      { name: "é", rx_bytes: 10, tx_bytes: 0 },
      { name: "e\u0301", rx_bytes: 10, tx_bytes: 0 },
    ];
    const unknown = networkByApp({ measured_ms: 0, apps: [] });
    await result.update(networkByApp({ apps }), unknown);
    const names = () => tableNames().slice(0, 2);
    await waitFor(() => expect(names()).toEqual(["ee\u0301", "éé"]));
    await result.update(
      networkByApp({
        apps: [...apps].reverse().map((app) => ({ ...app, rx_bytes: 20 })),
      }),
      unknown
    );
    await screen.findAllByText("20 B");
    expect(names()).toEqual(["ee\u0301", "éé"]);
    clickHeader("Total");
    expect(names()).toEqual(["ee\u0301", "éé"]);
    clickHeader("Now");
    expect(names()).toEqual(["ee\u0301", "éé"]);
    clickHeader("Now");
    expect(names()).toEqual(["ee\u0301", "éé"]);
  });
});

describe("Network app table headers", () => {
  it("preserves Now ascending while an uncached brushed range loads", async () => {
    const transport = createMockTransport({
      now: () => T + 5000,
      autoTick: false,
      historyRows: 600,
    });
    const read = transport.queryNetworkByApp.bind(transport);
    let release: (() => void) | undefined;
    transport.queryNetworkByApp = async (host, from, to) => {
      if (from === T - 120_000 && to === T - 100_000) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return read(host, from, to);
    };
    function BrushedApps() {
      const brush = useBrushStore();
      return createElement(
        Fragment,
        null,
        createElement(
          "button",
          {
            type: "button",
            onClick: () =>
              brush
                .getState()
                .select({ fromMs: T - 120_000, toMs: T - 100_000 }),
          },
          "Select earlier range"
        ),
        createElement(AppsCard, { windowMs: 300_000 })
      );
    }
    const { user } = renderWithProviders(
      createElement(BrushProvider, null, createElement(BrushedApps)),
      { transport, backfillMs: 600_000 }
    );
    await screen.findByRole("table", { name: "Network by app" });
    clickHeader("Now");
    clickHeader("Now");
    expect(header("Now")).toHaveAttribute("aria-sort", "ascending");
    await user.click(
      screen.getByRole("button", { name: "Select earlier range" })
    );
    await screen.findByText("Loading app totals…");
    expect(screen.queryByRole("table", { name: "Network by app" })).toBeNull();
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => release?.());
    await screen.findByRole("table", { name: "Network by app" });
    expect(header("Now")).toHaveAttribute("aria-sort", "ascending");
    expect(header("Total")).not.toHaveAttribute("aria-sort");
  });

  it.each([
    [
      "App",
      ["ccurl", "DDocker Desktop", "GGoogle Chrome"],
      ["GGoogle Chrome", "DDocker Desktop", "ccurl"],
    ],
    [
      "Down",
      ["DDocker Desktop", "GGoogle Chrome", "ccurl"],
      ["ccurl", "GGoogle Chrome", "DDocker Desktop"],
    ],
    [
      "Up",
      ["GGoogle Chrome", "DDocker Desktop", "ccurl"],
      ["ccurl", "DDocker Desktop", "GGoogle Chrome"],
    ],
    [
      "Total",
      ["DDocker Desktop", "GGoogle Chrome", "ccurl"],
      ["ccurl", "GGoogle Chrome", "DDocker Desktop"],
    ],
    [
      "Share",
      ["DDocker Desktop", "GGoogle Chrome", "ccurl"],
      ["ccurl", "GGoogle Chrome", "DDocker Desktop"],
    ],
    [
      "Now",
      ["GGoogle Chrome", "ccurl", "DDocker Desktop"],
      ["ccurl", "DDocker Desktop", "GGoogle Chrome"],
    ],
  ])(
    "sorts %s both ways and pins the remainder and footnote",
    async (label, first, second) => {
      renderApps();
      await screen.findByRole("table", { name: "Network by app" });
      expect(appNames()).toEqual([
        "DDocker Desktop",
        "GGoogle Chrome",
        "ccurl",
      ]);
      const pinned = tableNames().slice(-4);
      expect(pinned).toEqual([
        "Other apps",
        "Protocol overhead (est.)",
        "System and other",
        "macOS services (updates, backups, DNS). StatGlass can't see these without a helper.",
      ]);
      // Total starts descending, so switch away before exercising its first click.
      if (label === "Total") clickHeader("App");
      clickHeader(label);
      expect(header(label)).toHaveAttribute(
        "aria-sort",
        label === "App" ? "ascending" : "descending"
      );
      expect(appNames()).toEqual(first);
      expect(tableNames().slice(-4)).toEqual(pinned);
      clickHeader(label);
      expect(header(label)).toHaveAttribute(
        "aria-sort",
        label === "App" ? "descending" : "ascending"
      );
      expect(appNames()).toEqual(second);
      expect(tableNames().slice(-4)).toEqual(pinned);
    }
  );

  it("keeps unknown Now values last both ways, with names breaking ties and gap pairs", async () => {
    const result = renderApps();
    const measured = networkByApp({
      measured_ms: 10_000,
      apps: [{ name: "Google Chrome", rx_bytes: 50, tx_bytes: 0 }],
    });
    const unknown = networkByApp({ measured_ms: 0, apps: [] });
    await screen.findByRole("table", { name: "Network by app" });
    // A name absent from a measured bucket is idle, while an unmeasured bucket is unknown for all apps.
    await result.update(networkByApp(), measured);
    await screen.findByText("5 B/s");
    clickHeader("Now");
    expect(appNames()).toEqual(["GGoogle Chrome", "ccurl", "DDocker Desktop"]);
    await result.update(
      networkByApp({ apps: [...networkByApp().apps].reverse() }),
      measured
    );
    expect(appNames()).toEqual(["GGoogle Chrome", "ccurl", "DDocker Desktop"]);
    clickHeader("Now");
    expect(appNames()).toEqual(["ccurl", "DDocker Desktop", "GGoogle Chrome"]);
    await result.update(networkByApp(), unknown);
    await waitFor(() =>
      expect(
        within(screen.getByRole("table", { name: "Network by app" }))
          .getAllByRole("row")
          .slice(1, 4)
          .map((row) => within(row).getAllByRole("cell").at(-1)?.textContent)
      ).toEqual(["—", "—", "—"])
    );
    expect(appNames()).toEqual(["ccurl", "DDocker Desktop", "GGoogle Chrome"]);
    clickHeader("Now");
    expect(appNames()).toEqual(["ccurl", "DDocker Desktop", "GGoogle Chrome"]);
  });

  it("holds Now order on hover through a pushed frame, updates values and resumes on leave", async () => {
    let now = T + 5000;
    const transport = createMockTransport({ now: () => now, autoTick: false });
    transport.queryNetworkByApp = async (_host, from, to) => ({
      status: "ok",
      data: networkByApp({
        from_ms: from,
        to_ms: to,
        complete_to_ms: to,
        measured_ms: to - from,
        apps:
          to - from > 10_000
            ? networkByApp().apps
            : [
                {
                  name: "Google Chrome",
                  rx_bytes: now > T + 5000 ? 0 : 20e6,
                  tx_bytes: 0,
                },
                {
                  name: "Docker Desktop",
                  rx_bytes: now > T + 5000 ? 30e6 : 0,
                  tx_bytes: 0,
                },
              ],
      }),
    });
    const { user } = renderWithProviders(
      createElement(AppsCard, { windowMs: 300_000 }),
      { transport }
    );
    await screen.findByRole("table", { name: "Network by app" });
    clickHeader("Now");
    await waitFor(() => expect(appNames()[0]).toBe("GGoogle Chrome"));
    await user.hover(screen.getByRole("table", { name: "Network by app" }));
    const held = appNames();
    now += 10_000;
    await act(() => transport.tick());
    await screen.findByText("3.0 MB/s");
    expect(appNames()).toEqual(held);
    await user.unhover(screen.getByRole("table", { name: "Network by app" }));
    expect(appNames()[0]).toBe("DDocker Desktop");
  });

  it("shows a ranked Now header without clickable columns in the bounded live list", async () => {
    renderWithProviders(createElement(AppsNowCard));
    const table = await screen.findByRole("table", {
      name: "Network by app, now",
    });
    const ranked = within(table).getByRole("columnheader", { name: /Now/ });
    expect(ranked).toHaveAttribute("aria-sort", "descending");
    expect(ranked).toHaveTextContent("Now ↓");
    for (const head of within(table).getAllByRole("columnheader")) {
      expect(within(head).queryByRole("button")).toBeNull();
    }
  });
});
