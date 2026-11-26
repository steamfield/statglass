/**
 * Keeps the running native core in step with the phone's data policy.
 * Mounted once in the root layout; renders nothing.
 */
import { useEffect, useRef } from "react";
import { usePhoneSettings } from "@/data/phone-settings";
import { useNativeHandle } from "./native-handle";

/** Pushes phone settings the core needs to the native transport. */
export function NativeCoreBridge(): null {
  const target = useNativeHandle();
  const liveOnCellular = usePhoneSettings(
    (settings) => settings.liveOnCellular
  );
  const pending = useRef(Promise.resolve());

  useEffect(() => {
    if (target === null) return;
    // The core runs each call in its own task. Wait for each write to finish.
    pending.current = pending.current
      .then(async () => {
        const result = await target.setDataPolicy({
          live_on_cellular: liveOnCellular,
        });
        if (result.status === "error") throw result.error;
      })
      .catch((error: unknown) => {
        console.warn("[native core] could not set data policy", error);
      });
  }, [target, liveOnCellular]);
  return null;
}
