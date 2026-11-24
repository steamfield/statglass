import type {
  AlertDestinationsView,
  DeliveryOutcome,
  Destination,
} from "@core/generated/bindings";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { appKeys } from "@core/query-keys";
import type { CommandResult } from "@core/transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
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

/** Holds every test send until `release` is called. */
function holdTests(transport: MockTransport) {
  const send = transport.testAlertDestination.bind(transport);
  const held: (() => void)[] = [];
  transport.testAlertDestination = (destination) =>
    new Promise<CommandResult<DeliveryOutcome>>((resolve) => {
      held.push(() => void send(destination).then(resolve));
    });
  return () => {
    for (const run of held.splice(0)) run();
  };
}

/** The live delivery part of the row named `name`'s sub line. */
function rowStatus(name: string) {
  const row = screen
    .getByRole("switch", { name })
    .closest("div.flex.min-h-12") as HTMLElement;
  return within(row).getByRole("status");
}

async function sendTest(user: UserEvent, name: string) {
  await user.click(
    await screen.findByRole("button", { name: `Send test to ${name}` })
  );
}

describe("Send to panel test deliveries", () => {
  it("announces Sending… and the outcome in the row's status", async () => {
    const transport = await seeded([PHONE]);
    const release = holdTests(transport);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await sendTest(user, "Phone");
    expect(rowStatus("Phone")).toHaveTextContent("Sending…");
    act(() => release());
    await waitFor(() =>
      expect(rowStatus("Phone")).toHaveTextContent(/Delivered \d\d:\d\d/)
    );
    expect(rowStatus("Phone").textContent).not.toContain("ntfy");
  });

  it("forgets a test once the topic it went to is saved over", async () => {
    const transport = await seeded([PHONE]);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await sendTest(user, "Phone");
    await waitFor(() =>
      expect(rowStatus("Phone")).toHaveTextContent(/Delivered/)
    );
    await user.click(screen.getByRole("button", { name: "Edit Phone" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Edit destination" })
    );
    await user.click(dialog.getByRole("button", { name: "Generate" }));
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rowStatus("Phone")).toHaveTextContent("");
  });

  it("drops a test still out when the address changes under it", async () => {
    const transport = await seeded([PHONE]);
    const release = holdTests(transport);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await sendTest(user, "Phone");
    await act(async () => {
      await transport.saveAlertDestination({
        ...PHONE,
        kind: {
          ...PHONE.kind,
          topic: "statglass-moved",
        } as Destination["kind"],
      });
    });
    act(() => release());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send test to Phone" })
      ).toBeEnabled()
    );
    expect(rowStatus("Phone")).toHaveTextContent("");
  });

  it("shows a real delivery that arrives after a failed test", async () => {
    const transport = createMockTransport({
      scenarios: ["alert-delivery-fails"],
      autoTick: false,
    });
    await transport.saveAlertDestination(PHONE);
    const { user, queryClient } = renderWithProviders(<DestinationsPanel />, {
      transport,
    });
    await sendTest(user, "Phone");
    await waitFor(() =>
      expect(rowStatus("Phone")).toHaveTextContent(/Failed .* HTTP 403/)
    );
    // An alert delivered since, as the pushed view carries it.
    const at = new Date(2020, 0, 1, 9, 15).getTime();
    act(() =>
      queryClient.setQueryData<AlertDestinationsView>(
        appKeys.alertDestinations,
        {
          destinations: [
            {
              destination: PHONE,
              last: { at_ms: at, outcome: { kind: "delivered", status: 200 } },
            },
          ],
          load_error: null,
        }
      )
    );
    await waitFor(() =>
      expect(rowStatus("Phone")).toHaveTextContent("· Delivered 09:15")
    );
  });

  it("ignores a dialog test's answer once the form has changed", async () => {
    const transport = await seeded([PHONE]);
    const release = holdTests(transport);
    const { user, dialog } = await openEdit(transport, "Phone");
    await user.click(dialog.getByRole("button", { name: "Send test" }));
    expect(await dialog.findByText("Sending…")).toBeVisible();
    await user.type(dialog.getByRole("textbox", { name: "Topic" }), "-b");
    expect(dialog.queryByText("Sending…")).toBeNull();
    act(() => release());
    await act(async () => {});
    expect(dialog.queryByText(/Delivered/)).toBeNull();
  });

  it("notes that the phone must subscribe again when a saved topic changes", async () => {
    const transport = await seeded([PHONE]);
    const note = "Your phone needs to subscribe to the new topic.";
    const { user, dialog } = await openEdit(transport, "Phone");
    expect(dialog.queryByText(note)).toBeNull();
    await user.click(dialog.getByRole("button", { name: "Generate" }));
    expect(dialog.getByText(note)).toBeVisible();
    expect(dialog.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("says nothing about subscribing again for a new destination", async () => {
    const transport = await seeded([]);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await user.click(
      await screen.findByRole("button", { name: "Add destination" })
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Add destination" })
    );
    await user.click(dialog.getByRole("button", { name: "Generate" }));
    expect(dialog.queryByText(/subscribe to the new topic/)).toBeNull();
  });

  it("moves focus to Add destination after a delete", async () => {
    const transport = await seeded([PHONE, HOOK]);
    const { user, dialog } = await openEdit(transport, "Phone");
    await user.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add destination" })
      ).toHaveFocus()
    );
  });
});
