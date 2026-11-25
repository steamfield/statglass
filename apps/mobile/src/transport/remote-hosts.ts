/**
 * The phone's remote hosts in the desktop's `RemoteHostRecord` shape, which
 * the phone's screens and the mock transport share. Fields only a Mac
 * controller has (remote runs, agent updates) get their "none" values.
 */
import type { MobileRemoteHost, RemoteHostRecord } from "@core/generated/types";

/** `host` as a `RemoteHostRecord`. */
export function toRemoteHostRecord(host: MobileRemoteHost): RemoteHostRecord {
  void host;
  throw new Error("toRemoteHostRecord: not implemented (phase 4 lane c)");
}
