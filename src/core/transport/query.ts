import type { CommandError } from "@core/generated/bindings";
import type { CommandResult } from "./contracts";

/** Raised by query functions so TanStack Query sees a failed command. */
export class CommandFailure extends Error {
  readonly error: CommandError;
  constructor(error: CommandError) {
    super("message" in error ? `${error.kind}: ${error.message}` : error.kind);
    this.name = "CommandFailure";
    this.error = error;
  }
}

/**
 * A query's error as a `CommandFailure`, or null. Query errors are typed
 * `Error`: a rejected IPC call or a `select` throw is not a command failure,
 * so this narrows instead of casting.
 */
export function asCommandFailure(error: unknown): CommandFailure | null {
  return error instanceof CommandFailure ? error : null;
}

/** Unwrap a command result for a query function: data, or a thrown failure. */
export async function unwrap<T>(result: Promise<CommandResult<T>>): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new CommandFailure(r.error);
  return r.data;
}
