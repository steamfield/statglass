/**
 * Presentation of an unreachable Docker engine for the Containers page: what happened,
 * what StatGlass is doing about it and the one action that fixes it. Rust decides the
 * reason (`DockerSnapshot.availability`); this module only words it.
 */
import type {
  DockerRuntimeKind,
  DockerSnapshot,
} from "@core/generated/bindings";

/** The single recovery action the state card offers. */
export type EngineAction =
  | { kind: "launch"; runtime: DockerRuntimeKind; label: string }
  | { kind: "copy"; command: string; label: string }
  | { kind: "choose"; label: string }
  | { kind: "retry"; label: string };

/** Everything the engine state card renders. */
export interface EngineStateView {
  readonly tone: "info" | "warning" | "destructive";
  readonly title: string;
  readonly summary: string;
  readonly gifTheme: "not-found" | "network-error" | "server-error" | "timeout";
  readonly action: EngineAction | null;
  /** Offer Retry beside a primary action that isn't itself a retry. */
  readonly showRetry: boolean;
  /** Wall-clock ms of the next automatic attempt, for the countdown; null when none. */
  readonly nextAttemptMs: number | null;
  /** True during the post-launch window, while StatGlass waits for the engine. */
  readonly launching: boolean;
  /** Newest observation time when the engine has saved history, else null. */
  readonly lastReadingMs: number | null;
}

/**
 * Words an unreachable engine, or returns null when the page should render normally
 * (connected, connecting, paused, idle, or monitoring turned off).
 */
export function engineStateView(
  snapshot: DockerSnapshot,
  nowMs: number
): EngineStateView | null {
  void snapshot;
  void nowMs;
  return null;
}
