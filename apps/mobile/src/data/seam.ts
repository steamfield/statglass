/**
 * The slice of the shared `Transport` contract the phone reads through. The
 * demo mode's mock transport and the native `MobileTransport` both satisfy
 * it, so every screen and hook works the same on either.
 */
import type { Transport } from "@core/transport";

/** What the phone's screens and data hooks may call. */
export type PhoneTransport = Pick<
  Transport,
  | "listHosts"
  | "listRemoteHosts"
  | "onHostsChanged"
  | "onRemoteHostsChanged"
  | "getHost"
  | "getCapabilities"
  | "hostVitals"
  | "setHostsRecentInterest"
  | "retryRemoteHost"
  | "subscribeLive"
  | "queryHistory"
  | "queryEvents"
>;
