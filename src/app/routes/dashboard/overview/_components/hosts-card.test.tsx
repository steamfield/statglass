import type { HostRecord } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { HostSelectionContext } from "~/lib/host-selection";
import { OverviewHostsCard } from "./hosts-card";

async function setup(selectedName: string | null) {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["multi-host", "linux-host", "linux-identity-changed"],
  });
  const hosts = await transport.listHosts();
  const selected = (
    selectedName === null
      ? hosts.find((host) => host.is_local)
      : hosts.find((host) => host.display_name === selectedName)
  ) as HostRecord;
  const select = vi.fn();
  renderWithProviders(
    <HostSelectionContext value={{ hosts, selected: selected.id, select }}>
      <OverviewHostsCard origin="tl" />
    </HostSelectionContext>,
    { transport, route: "/dashboard/overview" }
  );
  const list = await screen.findByRole("list", { name: "Other hosts" });
  const rows = () =>
    within(list)
      .getAllByRole("button")
      .map((row) => row.textContent);
  return { rows, list, select };
}

it("lists each saved host with its live load, or its connection state", async () => {
  const { rows } = await setup(null);
  expect(rows()).toEqual([
    "Studio MacCPU 18% · Mem 42%",
    "linux-tailscaleConnection failed",
  ]);
  expect(screen.getByText("1 of 2 connected")).toBeVisible();
  expect(screen.getByRole("link", { name: "Other hosts" })).toHaveAttribute(
    "href",
    "/dashboard/hosts"
  );
});

it("leaves out the host on screen and offers This Mac instead", async () => {
  const { rows } = await setup("Studio Mac");
  expect(rows()).toEqual(["This Mac", "linux-tailscaleConnection failed"]);
  expect(screen.getByText("0 of 1 connected")).toBeVisible();
});

it("switches the dashboard to a host from its row", async () => {
  const { list, select } = await setup(null);
  fireEvent.click(within(list).getByRole("button", { name: /Studio Mac/ }));
  expect(select).toHaveBeenCalledWith("remote-studio");
});
