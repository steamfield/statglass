import { destinationAddress, newDestination } from "@core/alert-destinations";
import type {
  AlertDestinationsView,
  DeliveryOutcome,
  Destination,
} from "@core/generated/types";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import type { CommandResult } from "@core/transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { DestinationsPanel } from "./destinations-panel";

const PHONE_TOPIC = "statglass-phone12345";
const HOOK_PATH = "/hooks/team-alerts-0042";

const PHONE: Destination = {
  ...newDestination("ntfy", "c0ffee00-0000-4000-8000-0000000000f1"),
  name: "Phone",
  kind: {
    type: "ntfy",
    server: "https://ntfy.sh",
    topic: PHONE_TOPIC,
    token: null,
  },
};
const HOOK: Destination = {
  id: "c0ffee00-0000-4000-8000-0000000000f2",
  name: "Team chat",
  enabled: true,
  kind: { type: "webhook", url: `https://chat.example.com${HOOK_PATH}` },
};
const PAUSED: Destination = {
  ...PHONE,
  id: "c0ffee00-0000-4000-8000-0000000000f3",
  name: "Old phone",
  enabled: false,
};

const DELIVERED_AT = new Date(2026, 10, 23, 14, 2).getTime();
const FAILED_AT = new Date(2026, 10, 23, 14, 5).getTime();

async function seeded(
  destinations: Destination[],
  scenarios: ScenarioName[] = []
): Promise<MockTransport> {
  const transport = createMockTransport({ scenarios, autoTick: false });
  for (const destination of destinations) {
    const saved = await transport.saveAlertDestination(destination);
    if (saved.status === "error") throw new Error(JSON.stringify(saved.error));
  }
  return transport;
}

/** The store answers `view` for every read, as Rust would after deliveries. */
function holding(transport: MockTransport, view: AlertDestinationsView) {
  transport.getAlertDestinations = async () => structuredClone(view);
}

/** Holds every test delivery until `release` is called. */
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

function sendToRegion() {
  return screen.getByRole("region", { name: "Send to" });
}

function calls(transport: MockTransport, command: string) {
  return transport.calls
    .filter((c) => c.command === command)
    .map((c) => c.args[0]);
}

describe("Send to panel", () => {
  it("starts with this Mac's notifications and offers Add destination", async () => {
    const transport = await seeded([]);
    renderWithProviders(<DestinationsPanel />, { transport });
    const region = await screen.findByRole("region", { name: "Send to" });
    expect(
      await within(region).findByText("Notifications on this Mac")
    ).toBeVisible();
    expect(
      within(region).getByRole("button", { name: "Add destination" })
    ).toBeEnabled();
    expect(within(region).queryAllByRole("switch")).toHaveLength(0);
  });

  it("opens the dialog on a new destination from Add destination", async () => {
    const transport = await seeded([]);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await user.click(
      await screen.findByRole("button", { name: "Add destination" })
    );
    expect(
      await screen.findByRole("dialog", { name: "Add destination" })
    ).toBeVisible();
  });

  it("lists each destination with its kind, short address and last delivery", async () => {
    const transport = await seeded([]);
    holding(transport, {
      destinations: [
        {
          destination: PHONE,
          last: {
            at_ms: DELIVERED_AT,
            outcome: { kind: "delivered", status: 200 },
          },
        },
        {
          destination: HOOK,
          last: {
            at_ms: FAILED_AT,
            outcome: { kind: "failed", reason: "http", detail: "HTTP 403" },
          },
        },
      ],
      load_error: null,
    });
    renderWithProviders(<DestinationsPanel />, { transport });
    await screen.findByRole("switch", { name: "Team chat" });
    const text = sendToRegion().textContent ?? "";
    const inOrder = [
      "Notifications on this Mac",
      "Phone",
      "ntfy",
      destinationAddress(PHONE),
      "Delivered 14:02",
      "Team chat",
      "Webhook",
      destinationAddress(HOOK),
      "Failed 14:05 · HTTP 403",
    ];
    let from = 0;
    for (const part of inOrder) {
      const at = text.indexOf(part, from);
      expect(at, `"${part}" after offset ${from} in "${text}"`).toBeGreaterThan(
        -1
      );
      from = at + part.length;
    }
    // A row never shows the whole secret.
    expect(text).not.toContain(PHONE_TOPIC);
    expect(text).not.toContain(HOOK_PATH);
  });

  it("saves a destination with its switch flipped", async () => {
    const transport = await seeded([PHONE, HOOK]);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    const phone = await screen.findByRole("switch", { name: "Phone" });
    expect(phone).toBeChecked();
    await user.click(phone);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Phone" })).not.toBeChecked()
    );
    // The first two saves seeded the list.
    expect(calls(transport, "alert_destination_save").slice(2)).toEqual([
      { ...PHONE, enabled: false },
    ]);
    const stored = await transport.getAlertDestinations();
    expect(stored.destinations.map((d) => d.destination)).toEqual([
      { ...PHONE, enabled: false },
      HOOK,
    ]);
  });

  it("sends a test, saying Sending… until the outcome arrives", async () => {
    const transport = await seeded([PHONE]);
    const release = holdTests(transport);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await user.click(
      await screen.findByRole("button", { name: "Send test to Phone" })
    );
    expect(await within(sendToRegion()).findByText(/Sending…/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Send test to Phone" })
    ).toBeDisabled();
    act(() => release());
    await waitFor(() =>
      expect(calls(transport, "alert_destination_test")).toEqual([PHONE])
    );
    expect(
      await within(sendToRegion()).findByText(/Delivered \d\d:\d\d/)
    ).toBeVisible();
    expect(within(sendToRegion()).queryByText(/Sending…/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Send test to Phone" })
    ).toBeEnabled();
  });

  it("shows a failed test's reason", async () => {
    const transport = await seeded([PHONE], ["alert-delivery-fails"]);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await user.click(
      await screen.findByRole("button", { name: "Send test to Phone" })
    );
    expect(
      await within(sendToRegion()).findByText(/Failed \d\d:\d\d · HTTP 403/)
    ).toBeVisible();
  });

  it("does not offer a test to a destination that is switched off", async () => {
    const transport = await seeded([PAUSED]);
    renderWithProviders(<DestinationsPanel />, { transport });
    expect(
      await screen.findByRole("button", { name: "Send test to Old phone" })
    ).toBeDisabled();
  });

  it("opens the dialog on a destination from its Edit button", async () => {
    const transport = await seeded([PHONE]);
    const { user } = renderWithProviders(<DestinationsPanel />, { transport });
    await user.click(await screen.findByRole("button", { name: "Edit Phone" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit destination",
    });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Phone"
    );
  });

  it("shows a destinations file that could not be read as one message and keeps working", async () => {
    const transport = await seeded([]);
    const reason =
      "alert-destinations.json could not be read and was moved to alert-destinations.json.bad";
    holding(transport, { destinations: [], load_error: reason });
    renderWithProviders(<DestinationsPanel />, { transport });
    const region = await screen.findByRole("region", { name: "Send to" });
    expect(
      await within(region).findAllByText(reason, { exact: false })
    ).toHaveLength(1);
    expect(
      within(region).getByRole("button", { name: "Add destination" })
    ).toBeEnabled();
  });

  it("shows a change pushed from elsewhere without reading again", async () => {
    const transport = await seeded([PHONE]);
    renderWithProviders(<DestinationsPanel />, { transport });
    await screen.findByRole("switch", { name: "Phone" });
    // Saved from another window: the event carries the new view.
    await act(async () => {
      await transport.saveAlertDestination({ ...PHONE, name: "Pocket" });
    });
    expect(await screen.findByRole("switch", { name: "Pocket" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Phone" })).toBeNull();
    expect(calls(transport, "alert_destinations_get")).toHaveLength(1);
  });
});
