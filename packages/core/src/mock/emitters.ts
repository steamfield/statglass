import type {
  AlertDestinationsView,
  CapabilitiesChanged,
  EventRecorded,
  HistoryHealthChanged,
  HostsChanged,
  NavigateRequested,
  RemoteHostsChanged,
  SettingsChanged,
  StarPromptStatus,
  UpdateStatus,
  WindowAppearanceChanged,
  WindowVisibilityChanged,
} from "@core/generated/types";
import type { Transport } from "../transport";
import { createEmitter } from "./emitter";
export function createMockEmitters() {
  return {
    updates: createEmitter<UpdateStatus>(),
    settings: createEmitter<SettingsChanged>(),
    caps: createEmitter<CapabilitiesChanged>(),
    appearance: createEmitter<WindowAppearanceChanged>(),
    visibility: createEmitter<WindowVisibilityChanged>(),
    navigate: createEmitter<NavigateRequested>(),
    health: createEmitter<HistoryHealthChanged>(),
    hosts: createEmitter<HostsChanged>(),
    remotes: createEmitter<RemoteHostsChanged>(),
    event: createEmitter<EventRecorded>(),
    starPrompt: createEmitter<StarPromptStatus>(),
    alertDestinations: createEmitter<AlertDestinationsView>(),
  };
}
export type MockEmitters = ReturnType<typeof createMockEmitters>;

/** The transport events that only relay an emitter, with nothing else behind them. */
export function mockEventSubscriptions(
  emitters: MockEmitters
): Pick<
  Transport,
  | "onNavigateRequested"
  | "onSettingsChanged"
  | "onHistoryHealthChanged"
  | "onEventRecorded"
  | "onCapabilitiesChanged"
  | "onHostsChanged"
  | "onWindowAppearanceChanged"
> {
  return {
    onNavigateRequested: emitters.navigate.on,
    onSettingsChanged: emitters.settings.on,
    onHistoryHealthChanged: emitters.health.on,
    onEventRecorded: emitters.event.on,
    onCapabilitiesChanged: emitters.caps.on,
    onHostsChanged: emitters.hosts.on,
    onWindowAppearanceChanged: emitters.appearance.on,
  };
}
