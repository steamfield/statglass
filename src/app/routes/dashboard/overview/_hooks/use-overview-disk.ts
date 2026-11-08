import { keyByLabel } from "@core/series-key";
import { useDiskIo, useDiskIoScope } from "~/hooks/use-disk-io";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useHeld } from "~/hooks/use-ring";
import { MIRROR_BARS } from "../_lib/chart-layout";

/** Current device rates and its I/O history over the module range. */
export function useOverviewDisk(windowMs: number) {
  const fixedEnd = useModuleEnd();
  const { local, inventory, device, range } = useDiskIoScope(
    windowMs,
    fixedEnd
  );
  const query = useDiskIo(device, range, MIRROR_BARS, fixedEnd === null);
  const readKey =
    device === null
      ? "disk.read_total"
      : keyByLabel("disk.read", "dev")(device);
  const writeKey =
    device === null
      ? "disk.write_total"
      : keyByLabel("disk.write", "dev")(device);
  const values = useHeld([readKey, writeKey]);
  return {
    devicesFailed: local && inventory.isError,
    read: values[readKey] ?? null,
    write: values[writeKey] ?? null,
    query,
    range,
    fixedEnd,
  };
}
