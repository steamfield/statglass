import { useEffect } from "react";
import { setNativeSnapshotCover } from "@/transport";

/** Keeps UIKit's app-switcher cover in sync with the phone's app lock setting. */
export function useSnapshotCover(enabled: boolean): void {
  useEffect(() => {
    setNativeSnapshotCover(enabled);
  }, [enabled]);
}
