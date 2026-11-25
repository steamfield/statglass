import { newDestination } from "@core/alert-destinations";
import type { Destination } from "@core/generated/types";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { act, screen } from "@testing-library/react";
import { createTestQueryClient, renderWithProviders } from "@tests/test-utils";
import {
  type AlertDestinationCommands,
  useAlertDestinationCommands,
  useAlertDestinations,
} from "./use-alert-destinations";

function ntfy(id: string, name: string): Destination {
  const base = newDestination("ntfy", id);
  if (base.kind.type !== "ntfy")
    throw new Error("expected an ntfy destination");
  return { ...base, name, kind: { ...base.kind, topic: "statglass-phone" } };
}

const PHONE = ntfy("c0ffee00-0000-4000-8000-0000000000f1", "Phone");
const LAPTOP = ntfy("c0ffee00-0000-4000-8000-0000000000f2", "Laptop");

/** Shows the hook's state as text; hands its commands to the test. */
function Probe({
  onCommands,
}: {
  onCommands?: (c: AlertDestinationCommands) => void;
}) {
  const { view, isPending, error } = useAlertDestinations();
  const commands = useAlertDestinationCommands();
  onCommands?.(commands);
  if (error) return <p>read failed: {error.message}</p>;
  if (isPending || !view) return <p>reading</p>;
  const names = view.destinations.map((d) => d.destination.name).join(", ");
  return <p>destinations: {names || "none"}</p>;
}

function transportWith(scenarios: ScenarioName[] = []): MockTransport {
  return createMockTransport({ scenarios, autoTick: false });
}

function reads(transport: MockTransport): number {
  return transport.calls.filter((c) => c.command === "alert_destinations_get")
    .length;
}

describe("useAlertDestinations", () => {
  it("shows a pushed change without reading again", async () => {
    const transport = transportWith();
    renderWithProviders(<Probe />, { transport });
    await screen.findByText("destinations: none");
    // Another window saves one; the event carries the new view.
    await act(async () => {
      await transport.saveAlertDestination(PHONE);
    });
    expect(await screen.findByText("destinations: Phone")).toBeVisible();
    expect(reads(transport)).toBe(1);
  });

  it("reads again on return, so a change made while away shows", async () => {
    const transport = transportWith();
    const queryClient = createTestQueryClient();
    const first = renderWithProviders(<Probe />, { transport, queryClient });
    await screen.findByText("destinations: none");
    first.unmount();
    // Saved while the page was closed: no listener hears the push.
    await transport.saveAlertDestination(PHONE);
    renderWithProviders(<Probe />, { transport, queryClient });
    expect(await screen.findByText("destinations: Phone")).toBeVisible();
    expect(reads(transport)).toBe(2);
  });

  it("reports a failed read as an error, not as no destinations", async () => {
    const transport = transportWith();
    transport.getAlertDestinations = async () => {
      throw new Error("ipc closed");
    };
    renderWithProviders(<Probe />, { transport });
    expect(
      await screen.findByText("read failed: ipc closed", undefined, {
        timeout: 3000,
      })
    ).toBeVisible();
    expect(screen.queryByText(/destinations:/)).toBeNull();
  });
});

describe("useAlertDestinationCommands", () => {
  async function rendered(transport: MockTransport) {
    let commands: AlertDestinationCommands | undefined;
    renderWithProviders(<Probe onCommands={(c) => (commands = c)} />, {
      transport,
    });
    await screen.findByText("destinations: none");
    if (!commands) throw new Error("the probe never rendered its commands");
    return commands;
  }

  it("saves and deletes, answering the command result and updating the list", async () => {
    const transport = transportWith();
    const commands = await rendered(transport);
    let saved:
      | Awaited<ReturnType<AlertDestinationCommands["save"]>>
      | undefined;
    await act(async () => {
      saved = await commands.save(PHONE);
      await commands.save(LAPTOP);
    });
    expect(saved?.status).toBe("ok");
    expect(
      await screen.findByText("destinations: Phone, Laptop")
    ).toBeVisible();
    await act(async () => {
      await commands.remove(PHONE.id);
    });
    expect(await screen.findByText("destinations: Laptop")).toBeVisible();
  });

  it("answers a rejected save with Rust's reason and keeps the list", async () => {
    const transport = transportWith();
    const commands = await rendered(transport);
    let answer:
      | Awaited<ReturnType<AlertDestinationCommands["save"]>>
      | undefined;
    await act(async () => {
      answer = await commands.save({ ...PHONE, name: "" });
    });
    expect(answer).toEqual({
      status: "error",
      error: {
        kind: "invalid_argument",
        message:
          "destination name must be 1 to 40 characters with no leading or trailing spaces",
      },
    });
    expect(screen.getByText("destinations: none")).toBeVisible();
  });

  it.each([
    ["delivers", [] as ScenarioName[], { kind: "delivered", status: 200 }],
    [
      "fails",
      ["alert-delivery-fails"] as ScenarioName[],
      { kind: "failed", reason: "http", detail: "HTTP 403" },
    ],
  ])(
    "answers a test that %s with its outcome",
    async (_case, scenarios, outcome) => {
      const commands = await rendered(transportWith(scenarios));
      const answer = await commands.test(PHONE);
      expect(answer).toEqual({ status: "ok", data: outcome });
    }
  );
});
