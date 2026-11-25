import { useSearchParams } from "react-router";
import { useSearchParamPatch } from "~/hooks/use-search-param-patch";
import { SpaceView } from "./_components/space-view";

/**
 * Utilities › Disk space (D-153): the on-demand space report. `vol` in the
 * URL is the volume whose scan or report is open; without it, the picker.
 */
export default function DiskSpaceRoute() {
  const [params] = useSearchParams();
  const set = useSearchParamPatch();
  return <SpaceView vol={params.get("vol")} onVol={(vol) => set({ vol })} />;
}
