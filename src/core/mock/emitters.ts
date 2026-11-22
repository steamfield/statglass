import type {
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
} from "@core/generated/bindings";
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
  };
}
export type MockEmitters = ReturnType<typeof createMockEmitters>;
