import { unwrap } from "@core/transport";
import { useEffect } from "react";
import { useTransport } from "~/lib/transport-context";

/** One page-level interest; Rust releases it when this window hides as well. */
export function useHostsRecentInterest() {
  const transport = useTransport();
  useEffect(() => {
    const set = (on: boolean) => {
      void unwrap(transport.setHostsRecentInterest(on)).catch(
        (error: unknown) =>
          console.error("[hosts] setting recent history interest failed", {
            on,
            error,
          })
      );
    };
    set(true);
    return () => set(false);
  }, [transport]);
}
