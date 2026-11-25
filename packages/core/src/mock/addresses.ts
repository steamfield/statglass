import type {
  HostAddressesInfo,
  HostId,
  RemoteHostRecord,
} from "@core/generated/types";
import type { MockCommands } from "./commands";
import type { MockTransport } from "./contracts";
import { MOCK_HOST_ID } from "./fixtures";
import { fail, MOCK_LOCAL_IPV4, MOCK_PUBLIC_IP, ok } from "./protocol";

export function mockAddressCommands(
  remotes: ReadonlyMap<HostId, { record: RemoteHostRecord }>,
  now: () => number,
  localInterface: () => string | null,
  localLinux: boolean,
  recordCall: MockCommands["record"]
): Pick<MockTransport, "networkAddresses" | "getHostAddresses"> {
  const networkAddresses: MockTransport["networkAddresses"] = async (host) => {
    if (host === MOCK_HOST_ID) {
      return ok(addressAnswer(localInterface(), localLinux, true, now(), true));
    }
    const remote = remotes.get(host)?.record;
    if (!remote) return fail({ kind: "unknown_host", host });
    if (remote.status.state !== "connected") {
      return fail({
        kind: "remote_unreachable",
        message: "the host is not connected",
      });
    }
    // The NAS in the hosts-outdated scenario connects but lacks this query.
    if (host === "remote-nas" && remote.status.agent_version === "0.0.9") {
      return fail({
        kind: "remote_unsupported",
        message: "Addresses are not available from this host",
      });
    }
    const linux = remote.os === "linux";
    // The Linux demo server is the fixture with no system curl.
    return ok(
      addressAnswer(
        linux ? "end0" : "en0",
        linux,
        false,
        now(),
        host !== "remote-linux"
      )
    );
  };
  return {
    networkAddresses,
    getHostAddresses(host) {
      recordCall("get_host_addresses", host);
      return networkAddresses(host);
    },
  };
}

function addressAnswer(
  iface: string | null,
  linux: boolean,
  local: boolean,
  now: number,
  curlAvailable: boolean
): HostAddressesInfo {
  if (iface === null) {
    return {
      interface: null,
      link_mbps: null,
      ipv4: [],
      ipv6: [],
      public_ip: {
        state: "unavailable",
        detail: { reason: "no local address" },
      },
      as_of_ms: now,
    };
  }
  return {
    interface: iface,
    link_mbps: linux ? 1000 : 1200,
    ipv4: [local ? MOCK_LOCAL_IPV4 : "192.0.2.20"],
    ipv6: [linux ? "2001:db8::2" : "2001:db8::1"],
    public_ip: curlAvailable
      ? {
          state: "known",
          detail: { ip: local ? MOCK_PUBLIC_IP : "203.0.113.20" },
        }
      : { state: "unavailable", detail: { reason: "curl not installed" } },
    as_of_ms: now,
  };
}
