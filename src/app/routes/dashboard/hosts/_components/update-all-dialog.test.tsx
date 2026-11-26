import { createMockTransport } from "@core/mock-transport";
import { updatable } from "@core/remote-hosts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  clickOutside,
  renderWithProviders,
} from "../../../../../../tests/test-utils";
import { UpdateAllDialog } from "./update-all-dialog";

describe("update all", () => {
  it("updates reachable Linux and Mac hosts in order, skips offline ones and keeps its list", async () => {
    const transport = createMockTransport({ scenarios: ["hosts-outdated"] });
    const behind = (await transport.listRemoteHosts()).filter(updatable);
    expect(behind.map((r) => r.config.name)).toEqual([
      "nas",
      "build-box",
      "studio",
      "pi",
    ]);
    const { user } = renderWithProviders(
      <UpdateAllDialog remotes={behind} close={() => {}} />,
      { transport }
    );
    await user.click(screen.getByRole("button", { name: "Update hosts" }));
    expect(await screen.findByText(/Requested on 3 of 3/)).toBeInTheDocument();
    // Updated hosts left the live list; the dialog still lists all four.
    expect(screen.getByText("nas")).toBeInTheDocument();
    expect(screen.getByText("Offline: not updated")).toBeInTheDocument();
    expect(
      transport.calls
        .filter((c) => c.command === "update_remote_agent")
        .map((c) => c.args[0])
    ).toEqual(["remote-nas", "remote-build-box", "remote-studio"]);
  });

  it("reports a host that refused the update", async () => {
    const transport = createMockTransport({ scenarios: ["hosts-outdated"] });
    transport.updateRemoteAgent = async (id) =>
      id === "remote-nas"
        ? {
            status: "error",
            error: { kind: "remote_unreachable", message: "ssh: timed out" },
          }
        : { status: "ok", data: null };
    const behind = (await transport.listRemoteHosts()).filter(updatable);
    const { user } = renderWithProviders(
      <UpdateAllDialog remotes={behind} close={() => {}} />,
      { transport }
    );
    await user.click(screen.getByRole("button", { name: "Update hosts" }));
    expect(await screen.findByText(/Requested on 2 of 3/)).toBeInTheDocument();
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
  });

  it("stays open on an outside click and while updates run", async () => {
    const transport = createMockTransport({ scenarios: ["hosts-outdated"] });
    let release = () => {};
    transport.updateRemoteAgent = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: "ok", data: null });
      });
    const behind = (await transport.listRemoteHosts()).filter(updatable);
    const close = vi.fn();
    const { user } = renderWithProviders(
      <UpdateAllDialog remotes={behind} close={close} />,
      { transport }
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Update hosts",
    });
    await clickOutside();
    expect(close).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Update hosts" })
    );
    await user.keyboard("{Escape}");
    expect(
      within(dialog).getByRole("button", { name: "Cancel" })
    ).toBeDisabled();
    expect(close).not.toHaveBeenCalled();
    release();
  });
});
