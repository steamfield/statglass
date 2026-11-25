import { commandError, commandErrorText } from "@core/command-error";
import type { HostAddressesInfo, HostId } from "@core/generated/types";
import { networkSubtitle } from "@core/network-lines";
import { remoteQueryText } from "@core/remote-errors";
import { unwrap } from "@core/transport";
import { useCallback, useState } from "react";
import { useFocusedAppEffect } from "./live";
import { usePhoneTransport } from "./transport-context";

const POLL_MS = 2000;
const MAX_POLLS = 5;

export interface AddressRow {
  label: string;
  value: string;
  /** Why the value is missing, for VoiceOver. */
  hint?: string;
}

interface AddressLines {
  /** Interface and link speed from the address answer, for the header. */
  subtitle: string | null;
  rows: readonly AddressRow[];
  /** Why the addresses couldn't be read at all. */
  error: string | null;
  supported: boolean;
}

const NO_ADDRESSES: AddressLines = {
  subtitle: null,
  rows: [],
  error: null,
  supported: true,
};

function publicRow(publicIp: HostAddressesInfo["public_ip"]): AddressRow {
  switch (publicIp.state) {
    case "known":
      return { label: "Public IP", value: publicIp.detail.ip };
    case "pending":
      return { label: "Public IP", value: "Looking up…" };
    case "unavailable":
      return {
        label: "Public IP",
        value: "Unavailable",
        hint: publicIp.detail.reason,
      };
    default:
      return { label: "Public IP", value: "Unavailable" };
  }
}

function addressLines(answer: HostAddressesInfo): AddressLines {
  const { interface: iface, link_mbps, ipv4, ipv6, public_ip } = answer;
  const speed = link_mbps === null ? null : link_mbps * 1_000_000;
  return {
    subtitle: networkSubtitle(iface, speed),
    rows: [
      ...ipv4.map((value) => ({ label: "IPv4", value })),
      ...ipv6.map((value) => ({ label: "IPv6", value })),
      publicRow(public_ip),
    ],
    error: null,
    supported: true,
  };
}

function addressFailure(error: unknown): AddressLines {
  if (commandError(error)?.kind === "remote_unsupported")
    return { ...NO_ADDRESSES, supported: false };
  return {
    ...NO_ADDRESSES,
    error:
      remoteQueryText(error, "addresses") ??
      commandErrorText(error, "Please try again."),
  };
}

/** Read on focus, with a fresh polling budget for each visible visit. */
export function useHostAddresses(host: HostId, connected = true): AddressLines {
  const transport = usePhoneTransport();
  const [result, setResult] = useState<{
    host: HostId;
    transport: typeof transport;
    lines: AddressLines;
  }>();
  useFocusedAppEffect(
    useCallback(() => {
      if (!connected) return;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async (pollsLeft: number) => {
        try {
          const answer = await unwrap(transport.networkAddresses(host));
          if (!active) return;
          setResult({ host, transport, lines: addressLines(answer) });
          if (answer.public_ip.state === "pending" && pollsLeft > 0) {
            timer = setTimeout(() => void read(pollsLeft - 1), POLL_MS);
          }
        } catch (error) {
          if (active)
            setResult({ host, transport, lines: addressFailure(error) });
        }
      };
      void read(MAX_POLLS);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [host, transport, connected])
  );
  return connected && result?.host === host && result.transport === transport
    ? result.lines
    : NO_ADDRESSES;
}
