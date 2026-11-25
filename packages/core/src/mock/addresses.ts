import type { PhoneQueries } from "../transport";

export const networkAddresses: PhoneQueries["networkAddresses"] = async () => ({
  status: "ok",
  data: {
    interface: null,
    link_mbps: null,
    ipv4: [],
    ipv6: [],
    public_ip: { state: "unavailable", detail: { reason: "not implemented" } },
    as_of_ms: 0,
  },
});
