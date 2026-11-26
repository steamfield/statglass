/**
 * Which burst profile (`burst-profiles.ts`) each mock metric follows, for
 * `buildSpecs` and the Linux host's specs. Unlisted metrics are constant:
 * counts, capacities, states and other values that hold between samples.
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
  "cpu.cluster.residency": "plateau",
  "cpu.loadavg": "level",
  "self.cpu": "plateau",
  "gpu.util": "gpu",
  "gpu.render": "gpu",
  "gpu.tiler": "gpu",
  "gpu.freq": "gpu",
  "gpu.residency": "plateau",
  "mem.used": "level",
  "mem.app": "level",
  "mem.wired": "level",
  "mem.compressed": "level",
  "mem.cached": "level",
  "mem.free": "level",
  "mem.pressure": "level",
  "mem.psi": "load",
  "power.cpu": "load",
  "power.gpu": "load",
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
