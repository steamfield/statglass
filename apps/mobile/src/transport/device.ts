import { getStatglassNative } from "@native/statglass-native";

/** Sets whether UIKit blurs the app-switcher snapshot when the app resigns active. */
export function setNativeSnapshotCover(enabled: boolean): void {
  getStatglassNative()?.setSnapshotCover(enabled);
}
