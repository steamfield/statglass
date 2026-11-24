import type { WindowVisibilityChanged } from "@core/generated/bindings";
import type { Event } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createTauriTransport } from "./native";

const listeners = new Map<
  number,
  { kind: string; label: string | undefined }
>();

function registerListener(args: unknown) {
  if (
    typeof args !== "object" ||
    args === null ||
    !("target" in args) ||
    !("handler" in args) ||
    typeof args.handler !== "number"
  )
    throw new Error("Invalid event registration");
  const target = args.target;
  if (
    typeof target !== "object" ||
    target === null ||
    !("kind" in target) ||
    typeof target.kind !== "string"
  )
    throw new Error("Invalid event target");
  listeners.set(args.handler, {
    kind: target.kind,
    label:
      "label" in target && typeof target.label === "string"
        ? target.label
        : undefined,
  });
  return args.handler;
}

function installEventBackend() {
  mockIPC((command, args) => {
    if (command === "plugin:event|listen") return registerListener(args);
    if (
      command === "plugin:event|unlisten" &&
      args &&
      "eventId" in args &&
      typeof args.eventId === "number"
    )
      listeners.delete(args.eventId);
    return undefined;
  });
}

// Native emit_to reaches both its own target and EventTarget::Any registrations.
function emitTo(label: string, visible: boolean) {
  const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
  if (
    typeof internals !== "object" ||
    internals === null ||
    !("runCallback" in internals) ||
    typeof internals.runCallback !== "function"
  )
    throw new Error("Tauri mock callbacks are not installed");
  for (const [id, target] of listeners) {
    if (target.kind !== "Any" && target.label !== label) continue;
    const event: Event<WindowVisibilityChanged> = {
      event: "window-visibility-changed",
      id,
      payload: { visible },
    };
    internals.runCallback(id, event);
  }
}

afterEach(() => {
  listeners.clear();
  clearMocks();
});

it("delivers native visibility only to the transport's own window", async () => {
  installEventBackend();
  mockWindows("dashboard");
  const dashboard = vi.fn();
  const offDashboard =
    createTauriTransport("dashboard").onWindowVisibility(dashboard);
  mockWindows("popover");
  const popover = vi.fn();
  const offPopover =
    createTauriTransport("popover").onWindowVisibility(popover);
  await vi.waitFor(() => expect(listeners.size).toBe(2));
  emitTo("dashboard", true);
  expect(dashboard).toHaveBeenCalledExactlyOnceWith(true);
  expect(popover).not.toHaveBeenCalled();
  emitTo("popover", false);
  expect(dashboard).toHaveBeenCalledTimes(1);
  expect(popover).toHaveBeenCalledExactlyOnceWith(false);
  offDashboard();
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  emitTo("dashboard", false);
  expect(dashboard).toHaveBeenCalledTimes(1);
  offPopover();
});
