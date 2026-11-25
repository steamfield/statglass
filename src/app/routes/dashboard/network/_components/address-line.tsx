import { CopyValue } from "~/components/copy-value";
import { useAddresses } from "~/hooks/use-addresses";
import { networkSubtitle } from "../_lib/network";

/**
 * The header's addresses (D-093, D-153): the host's IPv4 (its IPv6
 * when it has no IPv4) and the public address. Each copies on click.
 * Nothing shows until the local address is read.
 */
export function AddressLine({
  primary,
  link = null,
}: {
  primary: string | null;
  link?: number | null;
}) {
  const { iface, linkMbps, lan, publicIp, failure } = useAddresses(primary);
  const sampledLink = iface === primary ? link : null;
  const speed = linkMbps === null ? sampledLink : linkMbps * 1_000_000;
  const subtitle = networkSubtitle(iface, speed);
  if (failure !== undefined) {
    return (
      <>
        {subtitle}
        {" · "}
        <span className="text-muted-foreground" title={failure}>
          Addresses unavailable
        </span>
      </>
    );
  }
  if (lan === null) return subtitle;
  return (
    <>
      {subtitle}
      {" · "}
      <CopyValue value={lan} label="local IP address" />
      {" · Public "}
      {publicIp.data ? (
        <CopyValue value={publicIp.data} label="public IP address" />
      ) : (
        <span className="text-muted-foreground">
          {publicIp.isError ? "unavailable" : "…"}
        </span>
      )}
    </>
  );
}
