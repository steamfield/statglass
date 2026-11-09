import { fixed, MISSING } from "@core/format";
import { sk } from "@core/series-key";
import { THERMAL_LABEL, thermalState } from "@core/thermal";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CopyValue } from "~/components/copy-value";
import type { MachineSpec } from "~/components/machine-header";
import { useAddresses } from "~/hooks/use-addresses";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { cn } from "~/lib/utils";
import { useHost } from "~/stores/host-store";
import { held, keysOf, usePrimaryIface } from "~/stores/live-selectors";

const LOADAVG = ["1", "5", "15"].map((window) => sk("cpu.loadavg", { window }));

/**
 * The primary interface with its local and public addresses, each copied on
 * click as on the Network page (D-093). A remote host shows the interface
 * alone: its addresses are not read from here.
 */
export function NetworkSpec() {
  const primary = usePrimaryIface();
  const local = useIsLocalHost();
  const { lan, publicIp } = useAddresses(primary);
  if (primary === null) return "No active interface";
  if (!local) return primary;
  return (
    <>
      {primary}
      {" · "}
      {lan === null ? (
        <span className="text-muted-foreground">…</span>
      ) : (
        <CopyValue value={lan} label="local IP address" />
      )}
      {" · Public "}
      {publicIp.data ? (
        <CopyValue value={publicIp.data} label="public IP address" />
      ) : (
        <span className="text-muted-foreground">
          {publicIp.isError ? "unavailable" : "…"}
        </span>
      )}
    </>
  );
}

/**
 * Whether the host's current layout carries `metric`: load average on macOS
 * and Linux, thermal state on macOS only.
 */
export function useHasMetric(metric: string): boolean {
  return useHost((s) => keysOf(s, metric).length > 0);
}

/** "2.41 · 2.10 · 1.95 (1, 5, 15 min)": the load averages. */
export function LoadSpec() {
  const values = useHost(useShallow((s) => LOADAVG.map((k) => held(s, k))));
  return (
    <span className="figures">
      {values.map((v) => (v === null ? MISSING : fixed(v, 2))).join(" · ")}
      <span className="text-muted-foreground"> (1, 5, 15 min)</span>
    </span>
  );
}

/**
 * The thermal state word; Serious and Critical carry the warning triangle
 * and critical octagon (design-system.md "Status colors").
 */
export function ThermalSpec() {
  const state = thermalState(useHost((s) => held(s, "thermal.state")));
  if (state === null) return MISSING;
  const warn = state === "serious";
  const critical = state === "critical";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        warn && "text-warning",
        critical && "text-destructive"
      )}
    >
      {warn && <TriangleAlert aria-hidden className="icon-regular size-3.5" />}
      {critical && (
        <OctagonAlert aria-hidden className="icon-regular size-3.5" />
      )}
      {THERMAL_LABEL[state]}
    </span>
  );
}

/**
 * The header's live state rows, after the machine's facts: load and thermal
 * state where the host reports them, then the network across both columns.
 */
export function stateSpecs(has: {
  load: boolean;
  thermal: boolean;
}): MachineSpec[] {
  const specs: MachineSpec[] = [];
  if (has.load) specs.push({ label: "Load", value: <LoadSpec /> });
  if (has.thermal) specs.push({ label: "Thermal", value: <ThermalSpec /> });
  specs.push({ label: "Network", value: <NetworkSpec />, wide: true });
  return specs;
}
