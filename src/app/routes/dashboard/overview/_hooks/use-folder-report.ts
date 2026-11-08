import { diskSpaceKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useTransport } from "~/lib/transport-context";
import {
  useSpaceScan,
  useSpaceStatus,
} from "~/routes/dashboard/disk/_hooks/use-disk-space";
import { useHostId } from "~/stores/host-store";

/** The boot volume's mount, the only volume whose scan keeps a summary. */
const BOOT = "/";

/**
 * The Largest folders card's report (D-131): the kept summary of the last
 * boot-volume scan, and a scan of the boot volume the user starts from the
 * card. Scanning is never automatic; it is the Space view's scan, so either
 * place shows the other's progress, and `useSpaceStatus` reads the summary
 * again when either one's scan ends.
 */
export function useFolderReport() {
  const transport = useTransport();
  const host = useHostId();
  const summary = useQuery({
    queryKey: diskSpaceKeys.highlights(host),
    queryFn: () => unwrap(transport.diskSpaceHighlights(host)),
  });
  const status = useSpaceStatus(true).data;
  const scan = useSpaceScan();
  const scanning = status?.phase === "scanning" && status.volume === BOOT;
  // How the last boot scan failed, from here or from the Space view.
  const failed =
    status?.phase === "failed" && status.volume === BOOT
      ? (status.error ?? "Couldn't finish the report.")
      : null;
  return {
    summary,
    /** Share of the volume's used space measured so far, while scanning. */
    progress: scanning
      ? Math.min(
          1,
          (status.measured_bytes ?? 0) / Math.max(1, status.used_bytes ?? 0)
        )
      : null,
    /** Another volume's scan is running; a new one can't start until it ends. */
    busy: status?.phase === "scanning" && !scanning,
    starting: scan.starting,
    error: scan.error ?? failed,
    run: () => void scan.start(BOOT, []),
    cancel: () => void scan.cancel(),
  };
}
