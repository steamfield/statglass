import type { LiveProcess } from "@core/generated/bindings";

/**
 * A `LiveProcess` row with nothing measured beyond 0% CPU and 0 bytes:
 * started at `pid` µs, named `process<pid>`, run by `me`. `over` replaces
 * fields; a test that depends on a value passes it.
 */
export function liveProcess(
  over: Partial<LiveProcess> & Pick<LiveProcess, "pid">
): LiveProcess {
  return {
    start_time_us: over.pid,
    name: `process${over.pid}`,
    cpu_pct: 0,
    mem_bytes: 0,
    compressed_bytes: null,
    threads: 1,
    idle_wakeups_per_s: null,
    energy: null,
    disk_read_bps: null,
    disk_write_bps: null,
    net_rx_bps: null,
    net_tx_bps: null,
    gpu_pct: null,
    ports: null,
    user: "me",
    refusal: null,
    ...over,
  };
}
