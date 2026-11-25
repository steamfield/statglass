import { getStatglassNative } from "@native/statglass-native";
import { useEffect } from "react";

/** Sets whether UIKit blurs the app-switcher snapshot when the app resigns active. */
export function setNativeSnapshotCover(enabled: boolean): void {
  getStatglassNative()?.setSnapshotCover(enabled);
}

/** Keeps UIKit's app-switcher cover in sync with the phone's app lock setting. */
export function useSnapshotCover(enabled: boolean): void {
  useEffect(() => {
    setNativeSnapshotCover(enabled);
  }, [enabled]);
}
