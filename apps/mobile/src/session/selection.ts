/** Actions that change the selected transport in response to session events. */
import { useCallback } from "react";
import type { PhoneTransport } from "@/data/seam";
import { useSetPhoneTransport } from "@/data/transport-context";
import { useNativeCore } from "@/transport";

/**
 * Makes the started native core the active transport.
 * @returns Whether the selection changed. False if the core is still starting
 * or already selected.
 * @throws Outside PhoneTransportProvider.
 */
export function useSelectNativeCore(): () => boolean {
  const { core } = useNativeCore();
  const setTransport = useSetPhoneTransport();

  return useCallback(
    () => core !== null && setTransport(core, false),
    [core, setTransport]
  );
}

/**
 * Clears the active transport if it is still `expected`, for a roster that emptied.
 * @throws Outside PhoneTransportProvider.
 */
export function useClearTransport(): (expected: PhoneTransport) => void {
  const setTransport = useSetPhoneTransport();
  return useCallback(
    (expected: PhoneTransport) => {
      setTransport(null, false, expected);
    },
    [setTransport]
  );
}
