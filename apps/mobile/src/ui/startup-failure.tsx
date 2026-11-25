import { commandErrorText } from "@core/command-error";
import { nativeErrorText } from "@core/native-errors";
import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";
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

/** Announces each startup failure as it appears, including on another route. */
export function useAnnounceStartupFailure() {
  const { error } = useNativeCore();
  const announced = useRef<StartupError | null>(null);
  useEffect(() => {
    if (error && announced.current !== error) {
      AccessibilityInfo.announceForAccessibility(startupCopy(error).title);
    }
    announced.current = error;
  }, [error]);
}

export function StartupFailurePanel() {
  const { error, retry } = useNativeCore();
  return error ? <RetryPanel {...startupCopy(error)} retry={retry} /> : null;
}
