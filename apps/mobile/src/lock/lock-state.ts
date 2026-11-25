export type UnlockResult = "unlocked" | "cancelled" | "failed";

export interface LockState {
  // AppState.currentState can contain an iOS state beyond the event union.
  phase: string;
  mode: "disabled" | "unlocked" | "enabling-resume" | "locked";
  prompt: "idle" | "queued" | "running" | "stale";
  promptInactive: boolean;
  error: boolean;
}

export type LockEvent =
  | { type: "app-state"; phase: string }
  | { type: "enabled"; enabled: boolean }
  | { type: "request-unlock" }
  | { type: "prompt-started" }
  | { type: "prompt-resolved"; result: UnlockResult };

/** An app that starts with the setting enabled requires an unlock. */
export function initialLockState(enabled: boolean, phase: string): LockState {
  return requestPrompt({
    phase,
    mode: enabled ? "locked" : "disabled",
    prompt: "idle",
    promptInactive: false,
    error: false,
  });
}

export function isLockCovered({ mode, phase }: LockState): boolean {
  return mode === "locked" || (mode === "unlocked" && phase !== "active");
}

function requestPrompt(state: LockState): LockState {
  if (
    state.mode !== "locked" ||
    state.phase !== "active" ||
    state.prompt !== "idle"
  )
    return state;
  return { ...state, prompt: "queued", error: false };
}

function invalidatePrompt(prompt: LockState["prompt"]): LockState["prompt"] {
  return prompt === "running" || prompt === "stale" ? "stale" : "idle";
}

function changePhase(state: LockState, phase: string): LockState {
  if (state.phase === phase) return state;
  const next = { ...state, phase };
  if (state.mode === "disabled") return next;
  switch (phase) {
    case "active":
      if (state.mode === "enabling-resume")
        return { ...next, mode: "unlocked" };
      if (state.promptInactive) return { ...next, promptInactive: false };
      return requestPrompt(next);
    case "inactive":
      if (state.mode === "enabling-resume") return next;
      if (state.prompt === "running") return { ...next, promptInactive: true };
      return {
        ...next,
        mode: "locked",
        prompt: invalidatePrompt(state.prompt),
      };
    default:
      return {
        ...next,
        mode: "locked",
        prompt: invalidatePrompt(state.prompt),
        promptInactive: false,
      };
  }
}

function changeSetting(state: LockState, enabled: boolean): LockState {
  if (enabled === (state.mode !== "disabled")) return state;
  if (!enabled) {
    return {
      ...state,
      mode: "disabled",
      prompt: invalidatePrompt(state.prompt),
      promptInactive: false,
      error: false,
    };
  }
  // The settings prompt has succeeded. iOS may still be dismissing its UI.
  switch (state.phase) {
    case "active":
      return { ...state, mode: "unlocked" };
    case "inactive":
      return { ...state, mode: "enabling-resume" };
    default:
      return { ...state, mode: "locked" };
  }
}

function resolvePrompt(state: LockState, result: UnlockResult): LockState {
  if (state.prompt === "stale")
    return requestPrompt({ ...state, prompt: "idle" });
  if (state.prompt !== "running") return state;
  return {
    ...state,
    mode: result === "unlocked" ? "unlocked" : "locked",
    prompt: "idle",
    error: result === "failed",
  };
}

/** Describes the next lock state without calling AppState or iOS authentication. */
export function nextLockState(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case "app-state":
      return changePhase(state, event.phase);
    case "enabled":
      return changeSetting(state, event.enabled);
    case "request-unlock":
      return requestPrompt(state);
    case "prompt-started":
      return state.prompt === "queued"
        ? { ...state, prompt: "running" }
        : state;
    case "prompt-resolved":
      return resolvePrompt(state, event.result);
  }
}
