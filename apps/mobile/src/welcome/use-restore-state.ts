import { commandError } from "@core/command-error";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { useIsDemo, useOptionalPhoneTransport } from "@/data/transport-context";

// The transport swap and a successful pair both invalidate the host namespace.
const restoreStateKey = [...hostKeys.all, "pairing-state"] as const;

export function useRestoreState() {
  const focused = useIsFocused();
  const transport = useOptionalPhoneTransport();
  const demo = useIsDemo();
  const { data, error } = useQuery({
    queryKey: restoreStateKey,
    queryFn: () => (transport ? unwrap(transport.pairingState()) : null),
    enabled: focused && transport !== null && !demo,
  });

  useEffect(() => {
    if (error) {
      console.warn(
        "[pairing] Could not read restore state",
        commandError(error) ?? error
      );
    }
  }, [error]);

  return !demo && transport !== null && data?.key_changed === true;
}
