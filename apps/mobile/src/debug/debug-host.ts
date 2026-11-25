import type { MobileHost, RemoteRoute } from "@core/generated/types";
import { sshEndpointError } from "@core/remote-errors";

export interface DebugHostFields {
  address: string;
  user: string;
  port: string;
  route: RemoteRoute;
  helper: string;
  hostId: string;
  hostKey: string;
}

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const HOST_PIN = /^(\S+)\s+(SHA256:[A-Za-z0-9+/]{43})$/;

export function debugHost(fields: DebugHostFields): MobileHost {
  const address = fields.address.trim();
  const user = fields.user.trim();
  const port = fields.port.trim();
  const id = fields.hostId.trim();
  if (!address) throw new Error("Enter the Mac’s address.");
  if (address.includes("@") || sshEndpointError(address)) {
    throw new Error(
      "Enter a hostname or IP address. Put the username in SSH user."
    );
  }
  if (!user) throw new Error("Enter the SSH user.");
  if (
    port &&
    (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  ) {
    throw new Error("Enter an SSH port from 1 to 65535.");
  }
  if (!UUID.test(id))
    throw new Error("Enter the Mac’s StatGlass host ID as a UUID.");
  const [, algorithm, sha256] = HOST_PIN.exec(fields.hostKey.trim()) ?? [];
  if (!algorithm || !sha256) {
    throw new Error("Enter the SSH key algorithm and SHA256 fingerprint.");
  }

  return {
    id: id.toLowerCase(),
    name: address,
    user,
    port: port ? Number(port) : null,
    targets: [{ route: fields.route, host: address }],
    host_keys: [{ algorithm, sha256 }],
    command: { kind: "mac_helper", path: fields.helper.trim() },
  };
}
