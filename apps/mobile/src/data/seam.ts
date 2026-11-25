/**
 * The slice of the shared `Transport` contract the phone reads through. The
 * demo mode's mock transport and the native `MobileTransport` both satisfy
 * it, so every screen and hook works the same on either.
 */
import type { PhoneRemoteHostRecord } from "@core/phone-connection";
import type { PhoneQueries, Transport } from "@core/transport";

/** What the phone's screens and data hooks may call. */
export type PhoneTransport = PhoneQueries &
  Pick<
    Transport,
    | "listHosts"
    | "onHostsChanged"
    | "onRemoteHostsChanged"
    | "getHost"
    | "getCapabilities"
    | "hostVitals"
    | "retryRemoteHost"
    | "setProcessInterest"
    | "subscribeLive"
  > & { listRemoteHosts(): Promise<PhoneRemoteHostRecord[]> };
