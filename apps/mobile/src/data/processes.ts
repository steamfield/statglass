import type { HostId, ProcessView } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { useCallback, useRef } from "react";
import { useFocusedAppEffect, useHostLiveStream } from "./live";
import { usePhoneTransport } from "./transport-context";

/** A visible live table owns process sampling on its host's current stream. */
export function useProcessDemand(host: HostId, view: ProcessView | null) {
  const transport = usePhoneTransport();
  const stream = useHostLiveStream(host);
  const pending = useRef(Promise.resolve());
  useFocusedAppEffect(
    useCallback(() => {
      if (stream === null || view === null) return;
      const set = (interest: ProcessView | null) => {
        pending.current = pending.current
          .then(() =>
            unwrap(
              transport.setProcessInterest(
                host,
                interest !== null,
                interest,
                stream
              )
            )
          )
          .then(
            () => undefined,
            (error) => {
              console.warn(
                "Could not update live process interest",
                host,
                error
              );
            }
          );
      };
      set(view);
      return () => set(null);
    }, [host, stream, transport, view])
  );
}
