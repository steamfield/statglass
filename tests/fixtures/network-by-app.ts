import type { NetworkByApp } from "@core/generated/bindings";

/** Where `networkByApp()`'s window starts, ms. */
export const NETWORK_BY_APP_FROM_MS = 1_700_000_000_000;

/**
 * A complete 90 s `query_network_by_app` answer at 10 s resolution from
 * `NETWORK_BY_APP_FROM_MS`: three apps, with overhead and system traffic left
 * over on the interface. `over` replaces fields.
 */
export function networkByApp(over: Partial<NetworkByApp> = {}): NetworkByApp {
  const T = NETWORK_BY_APP_FROM_MS;
  return {
    from_ms: T,
    to_ms: T + 90_000,
    complete_to_ms: T + 90_000,
    resolution_ms: 10_000,
    measured_ms: 90_000,
    coverage: [{ from_ms: T, to_ms: T + 90_000, tier: "s10" }],
    apps: [
      { name: "Docker Desktop", rx_bytes: 286e6, tx_bytes: 1.4e6 },
      { name: "Google Chrome", rx_bytes: 64e6, tx_bytes: 3.6e6 },
      { name: "curl", rx_bytes: 3.8e6, tx_bytes: 10e3 },
    ],
    other_apps_rx_bytes: 0,
    other_apps_tx_bytes: 0,
    iface_rx_bytes: 380e6,
    iface_tx_bytes: 50e6,
    overhead_rx_bytes: 18e6,
    overhead_tx_bytes: 9e6,
    system_rx_bytes: 8.2e6,
    system_tx_bytes: 35.99e6,
    clamped: false,
    ...over,
  };
}
