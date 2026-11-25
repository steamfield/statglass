/** Startup error copy, announcements and recovery for the native core. */
import { commandErrorText } from "@core/command-error";
import { nativeErrorText } from "@core/native-errors";
import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { useNativeCore } from "@/transport";
import { RetryPanel } from "./retry-panel";

type StartupError = NonNullable<ReturnType<typeof useNativeCore>["error"]>;

function startupCopy(error: StartupError) {
  const title = "StatGlass couldn’t start";
  if ("source" in error) {
    const copy = nativeErrorText(error);
    return {
      title: copy.title || title,
      detail: copy.recovery || error.message,
    };
  }
  return { title, detail: commandErrorText(error, "") };
}

/** Announces each startup failure once while no transport is selected. */
export function useAnnounceStartupFailure() {
  const { error } = useNativeCore();
  const transport = useOptionalPhoneTransport();
  const announced = useRef<StartupError | null>(null);
  useEffect(() => {
    if (error === null) {
      announced.current = null;
      return;
    }
    if (transport !== null || announced.current === error) return;
    announced.current = error;
    AccessibilityInfo.announceForAccessibility(startupCopy(error).title);
  }, [error, transport]);
}

/** Shows the native startup error and retries startup on request. */
export function StartupFailurePanel() {
  const { error, retry } = useNativeCore();
  return error ? <RetryPanel {...startupCopy(error)} retry={retry} /> : null;
}
