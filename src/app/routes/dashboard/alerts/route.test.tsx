import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { App } from "~/app";
import { LiveSidebar } from "~/routes/dashboard/_components/live-sidebar";
import SettingsRoute from "~/routes/dashboard/settings/route";
import { useHost } from "~/stores/host-store";
import { useSeriesKeys } from "./_hooks/use-series-keys";
import AlertsRoute from "./route";

/** The sidebar's link names, in order. */
const sidebarLinks = () =>
  within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");

describe("Alerts page wiring", () => {
  it("lists Alerts between Containers and Settings on This Mac", async () => {
    renderWithProviders(<LiveSidebar />);
    await screen.findByRole("link", { name: "Alerts" });
    const names = sidebarLinks();
    const alerts = names.indexOf("Alerts");
    expect(names[alerts - 1]).toBe("Containers");
    expect(names[alerts + 1]).toBe("Settings");
  });

  it.each([
    ["remote-studio", ["multi-host"] as const],
    ["remote-linux", ["linux-host", "multi-host"] as const],
  ])(
    "hides Alerts while %s is selected and keeps the page on This Mac",
    async (hostId, scenarios) => {
      const transport = createMockTransport({ scenarios: [...scenarios] });
      const view = render(
        <App
          transport={transport}
          router={{ initialEntry: "/dashboard/alerts" }}
          initialHost={hostId}
        />
      );
      await screen.findByRole("heading", { level: 1, name: "Alerts" });
      // Before its record arrives every host reads as local.
      await waitFor(() =>
        expect(screen.queryByRole("link", { name: "Alerts" })).toBeNull()
      );
      expect(screen.getByRole("link", { name: "Settings" })).toBeVisible();
      // The page reads This Mac's live store, not the selected host's.
      await waitFor(() =>
        expect(
          transport.calls.some(
            (call) =>
              call.command === "subscribe_live" && call.args[0] === MOCK_HOST_ID
          )
        ).toBe(true)
      );
      view.unmount();
      transport.dispose();
    }
  );

  it("leaves the Alerts panel out of Settings", async () => {
    renderWithProviders(<SettingsRoute />);
    await screen.findByRole("heading", { name: "Units" });
    expect(screen.queryByRole("heading", { name: "Alerts" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: /200% CPU|Serious or worse/ })
    ).toBeNull();
  });

  it("shows the Rules, Send to and Recent panels in that order", async () => {
    const transport = createMockTransport({ scenarios: ["alerts"] });
    const view = render(
      <App
        transport={transport}
        router={{ initialEntry: "/dashboard/alerts" }}
      />
    );
    await screen.findByRole("heading", { level: 1, name: "Alerts" });
    expect(
      await screen.findByRole("region", { name: "Rules" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Recent" })
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent)
        .filter((name) => ["Rules", "Send to", "Recent"].includes(name ?? ""))
    ).toEqual(["Rules", "Send to", "Recent"]);
    view.unmount();
    transport.dispose();
  });

  it("opens the New rule dialog on the first metric this Mac measures", async () => {
    const { user } = renderWithProviders(<AlertsRoute />, {
      route: "/dashboard/alerts",
    });
    const button = await screen.findByRole("button", { name: "New rule" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "New rule" });
    expect(
      within(dialog).getByRole("combobox", { name: "Metric" })
    ).toHaveTextContent("CPU usage");
    expect(
      within(dialog).getByRole("textbox", { name: "Threshold" })
    ).toHaveValue("90");
  });
});

describe("useSeriesKeys", () => {
  function Probe({ onRender }: { onRender: () => void }) {
    const keys = useSeriesKeys();
    return (
      <Profiler id="series-keys" onRender={onRender}>
        <span>{keys.includes("cpu.total") ? "cpu measured" : "waiting"}</span>
      </Profiler>
    );
  }

  function LayoutNo() {
    const no = useHost((s) => s.layoutNo);
    return <span>{no === null ? "no layout" : "layout"}</span>;
  }

  it("does not re-render its caller on a live tick", async () => {
    let renders = 0;
    const { transport } = renderWithProviders(
      <>
        <LayoutNo />
        <Probe
          onRender={() => {
            renders += 1;
          }}
        />
      </>
    );
    await screen.findByText("cpu measured");
    await screen.findByText("layout");
    // Drain subscription, settings and query startup before counting.
    await act(async () => {});
    const settled = renders;
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => transport.tick());
    }
    expect(renders).toBe(settled);
  });
});
