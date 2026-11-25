import type { PhoneQueries } from "../transport";
import type { MockTransport } from "./contracts";
import { MOCK_HOST_ID } from "./fixtures";
import { fail, MOCK_LOCAL_IPV4, MOCK_PUBLIC_IP, ok } from "./protocol";

export function createMockNetworkAddresses(
  {
    getHost,
    listRemoteHosts,
  }: Pick<MockTransport, "getHost" | "listRemoteHosts">,
  now: () => number
): PhoneQueries["networkAddresses"] {
  return async (host) => {
    const record = await getHost(host);
    if (record.status === "error") return record;
    const remote = (await listRemoteHosts()).find(
      ({ config }) => config.id === host
    );
    if (remote && remote.status.state !== "connected") {
      return fail({
        kind: "remote_unreachable",
        message: "the host is not connected",
      });
    }
    const linux = record.data.info.os === "linux";
    return ok({
      interface: linux ? "end0" : "en0",
      link_mbps: linux ? 1000 : 1200,
      ipv4: [host === MOCK_HOST_ID ? MOCK_LOCAL_IPV4 : "192.0.2.20"],
      ipv6: [linux ? "2001:db8::2" : "2001:db8::1"],
      public_ip: linux
        ? { state: "unavailable", detail: { reason: "curl not installed" } }
        : { state: "known", detail: { ip: MOCK_PUBLIC_IP } },
      as_of_ms: now(),
    });
  };
}
