import { useEffect } from "react";
import { setNativeSnapshotCover } from "@/transport/device";

export { setNativeSnapshotCover } from "@/transport/device";

/** Keeps UIKit's app-switcher cover in sync with the phone's app lock setting. */
export function useSnapshotCover(enabled: boolean): void {
  useEffect(() => {
    setNativeSnapshotCover(enabled);
  }, [enabled]);
}
