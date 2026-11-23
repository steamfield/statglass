import type {
  AlertDestinationsView,
  Destination,
} from "@core/generated/bindings";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import type { CommandResult } from "@core/transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { DestinationsPanel } from "./destinations-panel";

const PHONE: Destination = {
  id: "c0ffee00-0000-4000-8000-0000000000e1",
  name: "Phone",
  enabled: true,
  kind: {
    type: "ntfy",
    server: "https://ntfy.sh",
    topic: "statglass-phone12345",
    token: null,
  },
};
const HOOK: Destination = {
  id: "c0ffee00-0000-4000-8000-0000000000e2",
  name: "Team chat",
  enabled: true,
  kind: { type: "webhook", url: "https://chat.example.com/hooks/1" },
};

async function seeded(destinations: Destination[]): Promise<MockTransport> {
  const transport = createMockTransport({ autoTick: false });
  for (const destination of destinations) {
    const saved = await transport.saveAlertDestination(destination);
    if (saved.status === "error") throw new Error(JSON.stringify(saved.error));
  }
  return transport;
}

/** Holds every save until `release` is called. */
function holdSaves(transport: MockTransport) {
  const save = transport.saveAlertDestination.bind(transport);
  const held: (() => void)[] = [];
  transport.saveAlertDestination = (destination) =>
    new Promise<CommandResult<AlertDestinationsView>>((resolve) => {
      held.push(() => void save(destination).then(resolve));
    });
  return () => {
    for (const run of held.splice(0)) run();
  };
}

async function stored(transport: MockTransport): Promise<Destination[]> {
  return (await transport.getAlertDestinations()).destinations.map(
    (d) => d.destination
  );
}

function saves(transport: MockTransport) {
  return transport.calls.filter((c) => c.command === "alert_destination_save");
}

async function openEdit(transport: MockTransport, name: string) {
  const view = renderWithProviders(<DestinationsPanel />, { transport });
  await view.user.click(
    await screen.findByRole("button", { name: `Edit ${name}` })
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Edit destination",
  });
  return { ...view, dialog: within(dialog) };
}

describe("Send to panel edges", () => {
  it("closes on Cancel while a save is pending, with only Save locked", async () => {
    const transport = await seeded([PHONE]);
    holdSaves(transport);
    const { user, dialog } = await openEdit(transport, "Phone");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(dialog.getByRole("button", { name: "Send test" })).toBeEnabled();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on Escape while a save is pending", async () => {
    const transport = await seeded([PHONE]);
    holdSaves(transport);
    const { user, dialog } = await openEdit(transport, "Phone");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears a refused save's message once the form is edited", async () => {
    const transport = await seeded([PHONE]);
    const { user, dialog } = await openEdit(transport, "Phone");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.click(dialog.getByRole("button", { name: "Save" }));
    const refusal = await dialog.findByRole("alert");
    expect(refusal.textContent).not.toBe("");
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "P");
    expect(dialog.queryByRole("alert")).toBeNull();
  });

  it("adds an edited destination back when another window deleted it", async () => {
    const transport = await seeded([PHONE]);
    const { user, dialog } = await openEdit(transport, "Phone");
    await act(async () => {
      await transport.deleteAlertDestination(PHONE.id);
    });
    const name = dialog.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Pocket");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await stored(transport)).toEqual([{ ...PHONE, name: "Pocket" }]);
    expect(
      await screen.findByRole("switch", { name: "Pocket" })
    ).toBeInTheDocument();
  });

  it("keeps the switch state another window set while the dialog was open", async () => {
    const transport = await seeded([PHONE]);
    const { user, dialog } = await openEdit(transport, "Phone");
    await act(async () => {
      await transport.saveAlertDestination({ ...PHONE, enabled: false });
    });
    await user.type(dialog.getByRole("textbox", { name: "Name" }), " 2");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await stored(transport)).toEqual([
      { ...PHONE, name: "Phone 2", enabled: false },
    ]);
  });

  it("locks a row's controls while its switch saves, and only that row's", async () => {
    const transport = await seeded([PHONE, HOOK]);
    const release = holdSaves(transport);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await user.click(await screen.findByRole("switch", { name: "Phone" }));
    const locked = [
      screen.getByRole("switch", { name: "Phone" }),
      screen.getByRole("button", { name: "Send test to Phone" }),
      screen.getByRole("button", { name: "Edit Phone" }),
    ];
    for (const control of locked) expect(control).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Team chat" })).toBeEnabled();
    // A second click while the first save is out does nothing.
    await user.click(screen.getByRole("switch", { name: "Phone" }));
    act(() => release());
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Phone" })).toBeEnabled()
    );
    expect(screen.getByRole("switch", { name: "Phone" })).not.toBeChecked();
    expect(saves(transport).slice(2)).toHaveLength(1);
  });

  it("shows a failed read as an error, not as no destinations", async () => {
    const transport = await seeded([PHONE]);
    transport.getAlertDestinations = () =>
      Promise.reject(new Error("IPC closed"));
    renderWithProviders(<DestinationsPanel />, { transport });
    const region = await screen.findByRole("region", { name: "Send to" });
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "IPC closed"
    );
    expect(within(region).queryAllByRole("switch")).toHaveLength(0);
  });

  it("does not re-render on a live tick", async () => {
    const transport = await seeded([PHONE, HOOK]);
    let renders = 0;
    renderWithProviders(
      <Profiler id="send-to" onRender={() => (renders += 1)}>
        <DestinationsPanel />
      </Profiler>,
      { transport }
    );
    await screen.findByRole("switch", { name: "Team chat" });
    await act(async () => {});
    const settled = renders;
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => transport.tick());
    }
    expect(renders).toBe(settled);
  });
});
