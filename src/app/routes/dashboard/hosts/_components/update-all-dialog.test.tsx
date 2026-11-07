import { createMockTransport } from "@core/mock-transport";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  clickOutside,
  renderWithProviders,
} from "../../../../../../tests/test-utils";
import { UpdateAllDialog } from "./update-all-dialog";
import { pushable } from "./use-agent-update";

describe("update all", () => {
  it("pushes reachable hosts in order, skips offline ones and keeps its list", async () => {
    const transport = createMockTransport({ scenarios: ["hosts-outdated"] });
    const behind = (await transport.listRemoteHosts()).filter(pushable);
    expect(behind.map((r) => r.config.name)).toEqual([
      "nas",
      "build-box",
      "pi",
    ]);
    const { user } = renderWithProviders(
      <UpdateAllDialog remotes={behind} close={() => {}} />,
      { transport }
    );
    await user.click(screen.getByRole("button", { name: "Update agents" }));
    expect(await screen.findByText(/Requested on 2 of 2/)).toBeInTheDocument();
    // Updated hosts left the live list; the dialog still lists all three.
    expect(screen.getByText("nas")).toBeInTheDocument();
    expect(screen.getByText("Offline: not updated")).toBeInTheDocument();
    expect(
      transport.calls
        .filter((c) => c.command === "update_remote_agent")
        .map((c) => c.args[0])
    ).toEqual(["remote-nas", "remote-build-box"]);
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
    const behind = (await transport.listRemoteHosts()).filter(pushable);
    const { user } = renderWithProviders(
      <UpdateAllDialog remotes={behind} close={() => {}} />,
      { transport }
    );
    await user.click(screen.getByRole("button", { name: "Update agents" }));
    expect(await screen.findByText(/Requested on 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
  });

  it("stays open on an outside click and while pushes run", async () => {
    const transport = createMockTransport({ scenarios: ["hosts-outdated"] });
    let release = () => {};
    transport.updateRemoteAgent = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: "ok", data: null });
      });
    const behind = (await transport.listRemoteHosts()).filter(pushable);
    const close = vi.fn();
    const { user } = renderWithProviders(
      <UpdateAllDialog remotes={behind} close={close} />,
      { transport }
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Update agents",
    });
    await clickOutside();
    expect(close).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Update agents" })
    );
    await user.keyboard("{Escape}");
    expect(
      within(dialog).getByRole("button", { name: "Cancel" })
    ).toBeDisabled();
    expect(close).not.toHaveBeenCalled();
    release();
  });
});
