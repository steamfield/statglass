/**
 * How each mock metric moves and is sampled, for `buildSpecs` and the Linux
 * host's specs: the burst profile it follows (`burst-profiles.ts`; unlisted
 * metrics are constant: counts, capacities, states and other values that hold
 * between samples), whether its collector averages it over the interval, and
 * whether that collector backs off with only the tray open.
 */
import type { Shape } from "./burst-profiles";

const SHAPES: Record<string, Shape> = {
  "cpu.total": "load",
  "cpu.user": "load",
  "cpu.system": "load",
  "cpu.iowait": "load",
  "cpu.load": "load",
  "cpu.psi": "load",
  "cpu.cluster.active": "load",
  "cpu.cluster.freq": "load",
  "cpu.cluster.power": "load",
  "cpu.cluster.residency": "load",
  "cpu.loadavg": "level",
  "self.cpu": "plateau",
  "gpu.util": "gpu",
  "gpu.render": "gpu",
  "gpu.tiler": "gpu",
  "gpu.freq": "gpu",
  "gpu.residency": "gpu",
  "mem.used": "level",
  "mem.app": "level",
  "mem.wired": "level",
  "mem.compressed": "level",
  "mem.cached": "level",
  "mem.free": "level",
  "mem.pressure": "level",
  "mem.psi": "load",
  "power.cpu": "load",
  "power.gpu": "gpu",
  "power.dram": "load",
  "power.package": "load",
  "power.system": "load",
  "power.sensor": "load",
  "thermal.zone": "thermal",
  "thermal.cpu": "thermal",
  "thermal.gpu": "thermal",
  "thermal.hottest": "thermal",
  "thermal.sensor": "thermal",
  "fan.rpm": "plateau",
  "net.rx": "download",
  "net.rx_total": "download",
  "net.tx": "upload",
  "net.tx_total": "upload",
  "disk.psi": "load",
  "cgroup.cpu": "load",
  "cgroup.mem": "level",
  "cgroup.io_read": "disk",
  "cgroup.io_write": "disk",
  "cgroup.mem_psi": "load",
  "mock.pad": "plateau",
};

/** The profile `metric` follows: disk transfer metrics burst, see above. */
export function shapeOf(metric: string): Shape {
  if (metric.startsWith("disk.read") || metric.startsWith("disk.write"))
    return "disk";
  return SHAPES[metric] ?? "constant";
}

/**
 * Whether `metric` is a rate or an average over the sampling interval (CPU
 * time, bytes and ops, energy), as its collector computes it from counters,
 * rather than a gauge read at the instant.
 */
export function isAveraged(metric: string): boolean {
  return /^(cpu|net|disk|power)\./.test(metric);
}

/**
 * The seed of a disk device's transfers in one direction: its bytes, ops and
 * request time share it, and the Disk I/O page reads the same bursts.
 */
export function diskSeed(device: number, write: boolean): number {
  return 300 + 2 * device + (write ? 1 : 0);
}

/** The IOReport collector's metrics: cluster, GPU state and energy power. */
const IOREPORT_METRICS = new Set([
  "cpu.cluster.freq",
  "cpu.cluster.active",
  "cpu.cluster.residency",
  "cpu.cluster.power",
  "gpu.freq",
  "gpu.residency",
  "power.gpu",
  "power.ane",
  "power.dram",
  "power.package",
]);

/**
 * Whether `metric`'s collector slows to every 10 s with only the tray open
 * (D-061): IOReport's, and network and disk rates, which the default menu
 * bar does not show.
 */
export function isAdaptive(metric: string): boolean {
  return (
    IOREPORT_METRICS.has(metric) ||
    /^(net\.(rx|tx)|disk\.(read|write))/.test(metric)
  );
}
