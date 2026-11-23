/**
 * Disk's per-app table: the shared usage card with bytes read, written and
 * their total, apps expanding to their processes.
 */
import { formatBytes } from "@core/format";
import type { ProcessUsage } from "@core/generated/bindings";
import { useMemo } from "react";
import {
  UsageAppsCard,
  type UsageTableConfig,
} from "~/components/usage-apps-card";
import { useHostNoun } from "~/hooks/use-host-record";

/** Bytes read plus written; null when either was not measured. */
export const requestedBytes = (
  p: Pick<ProcessUsage, "read_bytes" | "write_bytes">
) =>
  p.read_bytes === null || p.write_bytes === null
    ? null
    : p.read_bytes + p.write_bytes;

const appConfig = (mac: boolean): UsageTableConfig => ({
  by: "disk",
  noun: "Disk",
  accent: "disk",
  columns: [
    { label: "Read", format: (p) => formatBytes(p.read_bytes) },
    { label: "Written", format: (p) => formatBytes(p.write_bytes) },
    {
      label: "Total",
      format: (p) => formatBytes(requestedBytes(p)),
      ranked: true,
    },
  ],
  footnote: `Bytes requested by ${mac ? "this user's processes" : "the processes the agent can read (every user's when it runs as root)"} across all devices. Caches and filesystem work mean these figures differ from device traffic.`,
});

/** "Disk by app" over the chart window or the brushed range. */
export function DiskProcesses({ windowMs }: { windowMs: number }) {
  const mac = useHostNoun() === "Mac";
  const config = useMemo(() => appConfig(mac), [mac]);
  return <UsageAppsCard windowMs={windowMs} config={config} />;
}
