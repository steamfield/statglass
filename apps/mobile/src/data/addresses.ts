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

interface AddressLines {
  line: string | null;
  ipv6: string | null;
  hint: string | null;
  supported: boolean;
}

const NO_ADDRESSES: AddressLines = {
  line: null,
  ipv6: null,
  hint: null,
  supported: true,
};

function addressLines(answer: HostAddressesInfo): AddressLines {
  const { interface: iface, link_mbps, ipv4, ipv6, public_ip } = answer;
  const speed = link_mbps === null ? null : link_mbps * 1_000_000;
  const value =
    public_ip.state === "known"
      ? public_ip.detail.ip
      : public_ip.state === "pending"
        ? "…"
        : "unavailable";
  return {
    line: [networkSubtitle(iface, speed), ...ipv4, `Public ${value}`].join(
      " · "
    ),
    ipv6: ipv6.length > 0 ? ipv6.join(" · ") : null,
    hint: public_ip.state === "unavailable" ? public_ip.detail.reason : null,
    supported: true,
  };
}

function addressFailure(error: unknown): AddressLines {
  if (commandError(error)?.kind === "remote_unsupported")
    return { ...NO_ADDRESSES, supported: false };
  return {
    ...NO_ADDRESSES,
    hint:
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
