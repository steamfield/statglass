import type { UiModule } from "@core/module-state";
import type { Accent } from "./accent";

export interface ModuleMeta {
  /** What every surface calls the module ("Power & Sensors"). */
  name: string;
  accent: Accent;
  /** What the module samples ("Load, clusters, per-core"). */
  description: string;
}

/**
 * The one table of module names, accents and descriptions. Absence wording
 * is not here: `unavailableText` (`@core/module-state`) is its only source,
 * so it can name the host.
 */
export const MODULE_META: Record<UiModule, ModuleMeta> = {
  cpu: { name: "CPU", accent: "cpu", description: "Load, clusters, per-core" },
  gpu: {
    name: "GPU",
    accent: "gpu",
    description: "Utilization and frequency",
  },
  memory: {
    name: "Memory",
    accent: "mem",
    description: "Pressure, composition, swap",
  },
  power: {
    name: "Power & Sensors",
    accent: "power",
    description: "Watts, SoC zones, fans",
  },
  network: {
    name: "Network",
    accent: "net",
    description: "Rates per interface",
  },
  disk: {
    name: "Disk",
    accent: "disk",
    description: "Throughput and capacity",
  },
  battery: {
    name: "Battery",
    accent: "battery",
    description: "Charge, health, cycles",
  },
};
