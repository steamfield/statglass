import { commandError } from "@core/command-error";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { useIsDemo, useOptionalPhoneTransport } from "@/data/transport-context";

export function useRestoreState() {
  const focused = useIsFocused();
  const transport = useOptionalPhoneTransport();
  const demo = useIsDemo();
  const { data, error } = useQuery({
    // Shared with the hosts list's "Needs pairing" read: one fact, one cache
    // entry. A transport swap and a successful pair invalidate the host namespace.
    queryKey: hostKeys.pairing(),
    queryFn: () => {
      if (!transport) throw new Error("pairing state read without a transport");
      return unwrap(transport.pairingState());
    },
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
