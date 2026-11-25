/**
 * Reads the core's JSON envelopes into the desktop's `CommandResult`, so
 * screens branch on `status` exactly as they do on the desktop.
 */
import type { CommandResult } from "@core/transport";

/**
 * The envelope in `json`. A string that is not an envelope becomes an
 * `internal` error naming what arrived, never a throw.
 */
export function parseEnvelope<T>(json: string): CommandResult<T> {
  void json;
  throw new Error("parseEnvelope: not implemented (phase 4 lane c)");
}
