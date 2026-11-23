import { newDestination } from "@core/alert-destinations";
import type { DeliveryOutcome, Destination } from "@core/generated/bindings";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import type { CommandResult } from "@core/transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { DestinationDialog, type DestinationDraft } from "./destination-dialog";

const NEW_ID = "c0ffee00-0000-4000-8000-0000000000f9";
const GENERATED_TOPIC = /^statglass-[a-z2-7]{20}$/;

const SAVED: Destination = {
  id: "c0ffee00-0000-4000-8000-0000000000f1",
  name: "Phone",
  enabled: true,
  kind: {
    type: "ntfy",
    server: "https://ntfy.sh",
    topic: "statglass-phone12345",
    token: "tk_secret",
  },
};

/** The dialog as the panel holds it: closing clears the draft. */
function Harness({ initial }: { initial: DestinationDraft }) {
  const [draft, setDraft] = useState<DestinationDraft | null>(initial);
  return <DestinationDialog draft={draft} onClose={() => setDraft(null)} />;
}

async function opened(
  draft: DestinationDraft,
  {
    scenarios = [],
    saved = [],
  }: { scenarios?: ScenarioName[]; saved?: Destination[] } = {}
) {
  const transport = createMockTransport({ scenarios, autoTick: false });
  for (const destination of saved) {
    const answer = await transport.saveAlertDestination(destination);
    if (answer.status === "error")
      throw new Error(JSON.stringify(answer.error));
  }
  const view = renderWithProviders(<Harness initial={draft} />, { transport });
  const title = draft.isNew ? "Add destination" : "Edit destination";
  const dialog = await screen.findByRole("dialog", { name: title });
  return { ...view, transport, dialog: within(dialog) };
}

const newNtfy = (): DestinationDraft => ({
  destination: newDestination("ntfy", NEW_ID),
  isNew: true,
});

function calls(transport: MockTransport, command: string) {
  return transport.calls
    .filter((c) => c.command === command)
    .map((c) => c.args[0]);
}

async function stored(transport: MockTransport): Promise<Destination[]> {
  return (await transport.getAlertDestinations()).destinations.map(
    (d) => d.destination
  );
}

function expectClosed() {
  return waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("Destination dialog", () => {
  it("switches between the ntfy and webhook fields and keeps the name", async () => {
    const { user, dialog } = await opened(newNtfy());
    expect(dialog.getByRole("radio", { name: "ntfy" })).toBeChecked();
    expect(dialog.getByRole("textbox", { name: "Server" })).toHaveValue(
      "https://ntfy.sh"
    );
    expect(dialog.getByRole("textbox", { name: "Topic" })).toBeVisible();
    expect(dialog.getByLabelText("Access token")).toBeVisible();
    expect(dialog.queryByRole("textbox", { name: "URL" })).toBeNull();

    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Phone");
    await user.click(dialog.getByRole("radio", { name: "Webhook" }));
    expect(dialog.getByRole("textbox", { name: "URL" })).toBeVisible();
    expect(dialog.queryByRole("textbox", { name: "Server" })).toBeNull();
    expect(dialog.queryByRole("textbox", { name: "Topic" })).toBeNull();
    expect(dialog.queryByLabelText("Access token")).toBeNull();
    expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Phone");

    await user.click(dialog.getByRole("radio", { name: "ntfy" }));
    expect(dialog.getByRole("textbox", { name: "Topic" })).toBeVisible();
    expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Phone");
  });

  it("fills the topic from Generate", async () => {
    const { user, dialog } = await opened(newNtfy());
    const topic = dialog.getByRole("textbox", { name: "Topic" });
    expect(topic).toHaveValue("");
    await user.click(dialog.getByRole("button", { name: "Generate" }));
    expect(
      (dialog.getByRole("textbox", { name: "Topic" }) as HTMLInputElement).value
    ).toMatch(GENERATED_TOPIC);
  });

  it("takes the access token in a password field", async () => {
    const { dialog } = await opened({ destination: SAVED, isNew: false });
    const token = dialog.getByLabelText("Access token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveValue("tk_secret");
  });

  it("saves a new ntfy destination and closes", async () => {
    const { user, dialog, transport } = await opened(newNtfy());
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Phone");
    await user.click(dialog.getByRole("button", { name: "Generate" }));
    const topic = (
      dialog.getByRole("textbox", { name: "Topic" }) as HTMLInputElement
    ).value;
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await expectClosed();
    expect(await stored(transport)).toEqual([
      {
        id: NEW_ID,
        name: "Phone",
        enabled: true,
        kind: {
          type: "ntfy",
          server: "https://ntfy.sh",
          topic,
          token: null,
        },
      },
    ]);
  });

  it("saves a webhook with its URL", async () => {
    const { user, dialog, transport } = await opened(newNtfy());
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Chat");
    await user.click(dialog.getByRole("radio", { name: "Webhook" }));
    await user.type(
      dialog.getByRole("textbox", { name: "URL" }),
      "https://chat.example.com/hooks/42"
    );
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await expectClosed();
    expect(await stored(transport)).toEqual([
      {
        id: NEW_ID,
        name: "Chat",
        enabled: true,
        kind: { type: "webhook", url: "https://chat.example.com/hooks/42" },
      },
    ]);
  });

  it("shows why the command refused a save and keeps the form", async () => {
    const { user, dialog, transport } = await opened(newNtfy());
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Phone");
    await user.type(
      dialog.getByRole("textbox", { name: "Topic" }),
      "my topic!"
    );
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(
      await dialog.findByText(
        "topic must be 1 to 64 letters, digits, hyphens or underscores"
      )
    ).toBeVisible();
    expect(calls(transport, "alert_destination_save")).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: "Add destination" })
    ).toBeVisible();
    expect(dialog.getByRole("textbox", { name: "Topic" })).toHaveValue(
      "my topic!"
    );
    expect(await stored(transport)).toEqual([]);
  });

  it("sends a test of the unsaved form, saying Sending… until it answers", async () => {
    const { user, dialog, transport } = await opened(newNtfy());
    const send = transport.testAlertDestination.bind(transport);
    const held: (() => void)[] = [];
    transport.testAlertDestination = (destination) =>
      new Promise<CommandResult<DeliveryOutcome>>((resolve) => {
        held.push(() => void send(destination).then(resolve));
      });
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Phone");
    await user.type(
      dialog.getByRole("textbox", { name: "Topic" }),
      "statglass-trial"
    );
    await user.click(dialog.getByRole("button", { name: "Send test" }));
    expect(await dialog.findByText(/Sending…/)).toBeVisible();
    act(() => {
      for (const run of held.splice(0)) run();
    });
    expect(await dialog.findByText(/Delivered \d\d:\d\d/)).toBeVisible();
    expect(calls(transport, "alert_destination_test")).toEqual([
      {
        id: NEW_ID,
        name: "Phone",
        enabled: true,
        kind: {
          type: "ntfy",
          server: "https://ntfy.sh",
          topic: "statglass-trial",
          token: null,
        },
      },
    ]);
    // A test saves nothing.
    expect(calls(transport, "alert_destination_save")).toEqual([]);
  });

  it("shows a failed test's reason", async () => {
    const { user, dialog } = await opened(
      { destination: SAVED, isNew: false },
      { scenarios: ["alert-delivery-fails"], saved: [SAVED] }
    );
    await user.click(dialog.getByRole("button", { name: "Send test" }));
    expect(
      await dialog.findByText(/Failed \d\d:\d\d · HTTP 403/)
    ).toBeVisible();
  });

  it("deletes an existing destination and closes", async () => {
    const { user, dialog, transport } = await opened(
      { destination: SAVED, isNew: false },
      { saved: [SAVED] }
    );
    await user.click(dialog.getByRole("button", { name: "Delete" }));
    await expectClosed();
    expect(calls(transport, "alert_destination_delete")).toEqual([SAVED.id]);
    expect(await stored(transport)).toEqual([]);
  });

  it("offers no Delete for a new destination", async () => {
    const { dialog } = await opened(newNtfy());
    expect(dialog.getByRole("button", { name: "Save" })).toBeVisible();
    expect(dialog.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("closes on Cancel without writing anything", async () => {
    const { user, dialog, transport } = await opened(
      { destination: SAVED, isNew: false },
      { saved: [SAVED] }
    );
    await user.clear(dialog.getByRole("textbox", { name: "Name" }));
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Renamed");
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await expectClosed();
    // Only the seeding save.
    expect(calls(transport, "alert_destination_save")).toHaveLength(1);
    expect(await stored(transport)).toEqual([SAVED]);
  });
});
