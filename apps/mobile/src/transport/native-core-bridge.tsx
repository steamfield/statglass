/**
 * Keeps the native core in step with the phone settings while the native
 * transport is chosen: sends the data policy whenever its settings change.
 * Mounted once in the root layout; renders nothing.
 */
import { useEffect, useRef } from "react";
import { usePhoneSettings } from "@/data/phone-settings";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { isNativeTransport } from "./native-transport";

/** Pushes phone settings the core needs to the native transport. */
export function NativeCoreBridge(): null {
  const transport = useOptionalPhoneTransport();
  const syncOnCellular = usePhoneSettings(
    (settings) => settings.syncOnCellular
  );
  const pending = useRef(Promise.resolve());

  useEffect(() => {
    if (!isNativeTransport(transport)) return;
    // The core runs each call in its own task. Wait for each write to finish.
    pending.current = pending.current
      .then(async () => {
        const result = await transport.setDataPolicy({
          sync_on_cellular: syncOnCellular,
        });
        if (result.status === "error") throw result.error;
      })
      .catch((error: unknown) => {
        console.warn("[native core] could not set data policy", error);
      });
  }, [transport, syncOnCellular]);
  return null;
}
