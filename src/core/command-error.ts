import type { CommandError } from "@core/generated/bindings";
import { CommandFailure } from "./transport/query";

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    typeof error.kind === "string"
  );
}

/**
 * The typed error a failed command carried: a query's `CommandFailure` or a
 * result's bare `CommandError`. `null` for anything else, such as a rejected
 * IPC call.
 */
export function commandError(error: unknown): CommandError | null {
  if (error instanceof CommandFailure) return error.error;
  return isCommandError(error) ? error : null;
}

/**
 * What a failed command tells the user: the bounded message Rust attached
 * (never a `CommandFailure`'s kind-prefixed text), or `fallback` for a kind
 * without one. A rejected IPC call keeps its own text, since that is the only
 * diagnostic there is; anything without text reads as `fallback`.
 */
export function commandErrorText(error: unknown, fallback: string): string {
  const typed = commandError(error);
  if (typed) {
    return "message" in typed && typed.message ? typed.message : fallback;
  }
  if (error instanceof Error) return error.message || fallback;
  return typeof error === "string" && error ? error : fallback;
}
