/**
 * Keeps the chosen native transport or the running debug core in step with
 * the phone's data policy.
 * Mounted once in the root layout; renders nothing.
 */
import { useEffect, useRef } from "react";
import { usePhoneSettings } from "@/data/phone-settings";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { getDebugCore, isNativeTransport } from "./native-transport";

/** Pushes phone settings the core needs to the native transport. */
export function NativeCoreBridge(): null {
  const transport = useOptionalPhoneTransport();
  const syncOnCellular = usePhoneSettings(
    (settings) => settings.syncOnCellular
  );
  const pending = useRef(Promise.resolve());

  useEffect(() => {
    // The debug screen supplies the initial policy and reports startup failures.
    const target = isNativeTransport(transport)
      ? transport
      : getDebugCore()?.catch(() => null);
    if (target === undefined) return;
    // The core runs each call in its own task. Wait for each write to finish.
    pending.current = pending.current
      .then(async () => {
        const core = await target;
        if (core === null) return;
        const result = await core.setDataPolicy({
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
