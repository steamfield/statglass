/** Finds the native transport for calls outside the phone data seam. */
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { useNativeCore } from "./core-provider";
import { isNativeTransport, type NativeTransport } from "./native-transport";

/**
 * Reads the started core or falls back to a selected native transport.
 * @returns Null when neither is available.
 * @throws Outside PhoneTransportProvider.
 */
export function useNativeHandle(): NativeTransport | null {
  const { core } = useNativeCore();
  const transport = useOptionalPhoneTransport();
  return core ?? (isNativeTransport(transport) ? transport : null);
}
