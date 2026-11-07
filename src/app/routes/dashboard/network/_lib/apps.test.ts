import { formatSpan } from "@core/format";
import {
  NETWORK_BY_APP_FROM_MS,
  networkByApp,
} from "@tests/fixtures/network-by-app";
import {
  appRows,
  appsTitle,
  firstRecordedMs,
  nowRates,
  openTailS,
  partialCoverage,
  remainderRows,
  unrecorded,
} from "./apps";

const T = NETWORK_BY_APP_FROM_MS;

describe("Apps title", () => {
  it("names the window with nothing selected", () => {
    expect(appsTitle(null, 300_000)).toBe("Apps, last 5 minutes");
    expect(appsTitle(null, 900_000)).toBe("Apps, last 15 minutes");
    expect(appsTitle(null, 1_800_000)).toBe("Apps, last 30 minutes");
    expect(appsTitle(null, 3_600_000)).toBe("Apps, last hour");
  });

  it("names the selection's length", () => {
    expect(appsTitle({ fromMs: T, toMs: T + 90_000 }, 300_000)).toBe(
      "Apps, selected 90 s"
    );
    expect(appsTitle({ fromMs: T, toMs: T + 120_000 }, 300_000)).toBe(
      "Apps, selected 2 min"
    );
  });

  it("formats spans", () => {
    expect(formatSpan(10_000)).toBe("10 s");
    expect(formatSpan(150_000)).toBe("2 min 30 s");
    expect(formatSpan(3_900_000)).toBe("1 h 5 min");
  });
});

describe("Apps rows", () => {
  it("shares are of the interface total; now comes from the latest bucket", () => {
    const now = nowRates(
      networkByApp({
        measured_ms: 10_000,
        apps: [{ name: "Google Chrome", rx_bytes: 11e6, tx_bytes: 0 }],
      })
    );
    const rows = appRows(networkByApp(), now);
    expect(rows.map((r) => [r.name, r.totalBytes, r.nowBps])).toEqual([
      ["Docker Desktop", 287.4e6, 0],
      ["Google Chrome", 67.6e6, 1.1e6],
      ["curl", 3.81e6, 0],
    ]);
    expect(rows[0]?.share).toBeCloseTo((287.4e6 / 430e6) * 100);
  });

  it("an unmeasured latest bucket leaves now unknown, not zero", () => {
    expect(nowRates(networkByApp({ measured_ms: 0, apps: [] }))).toBeNull();
    expect(appRows(networkByApp(), null).every((r) => r.nowBps === null)).toBe(
      true
    );
  });

  it("no share when nothing moved", () => {
    const rows = appRows(
      networkByApp({
        apps: [{ name: "curl", rx_bytes: 0, tx_bytes: 0 }],
        iface_rx_bytes: 0,
        iface_tx_bytes: 0,
        overhead_rx_bytes: 0,
        overhead_tx_bytes: 0,
        system_rx_bytes: 0,
        system_tx_bytes: 0,
      }),
      null
    );
    expect(rows[0]?.share).toBeNull();
  });

  // Regression: apps 30x the interface showed node at 1556.4%.
  it("shares add up to 100% even when the apps exceed the interface", () => {
    const a = networkByApp({
      apps: [
        { name: "node", rx_bytes: 1.8e6, tx_bytes: 195e6 },
        { name: "chrome-headless-shell", rx_bytes: 149e6, tx_bytes: 1.4e6 },
        { name: "Ghostty", rx_bytes: 27.1e6, tx_bytes: 0.3e6 },
      ],
      iface_rx_bytes: 9e6,
      iface_tx_bytes: 3.7e6,
      overhead_rx_bytes: 0,
      overhead_tx_bytes: 0,
      system_rx_bytes: 0,
      system_tx_bytes: 0,
      clamped: true,
    });
    const shares = [...appRows(a, null), ...remainderRows(a)].map(
      (r) => r.share ?? 0
    );
    expect(Math.max(...shares)).toBeLessThanOrEqual(100);
    expect(shares.reduce((n, s) => n + s, 0)).toBeCloseTo(100);
  });

  it("remainder: other apps only when non-zero, then overhead, then System and other", () => {
    expect(remainderRows(networkByApp()).map((r) => r.name)).toEqual([
      "Protocol overhead (est.)",
      "System and other",
    ]);
    const withOther = remainderRows(
      networkByApp({ other_apps_rx_bytes: 5e6, other_apps_tx_bytes: 1e6 })
    );
    expect(withOther.map((r) => [r.name, r.totalBytes])).toEqual([
      ["Other apps", 6e6],
      ["Protocol overhead (est.)", 27e6],
      ["System and other", 44.19e6],
    ]);
    expect(withOther.every((r) => r.nowBps === null)).toBe(true);
  });

  it("the parts add up to the interface", () => {
    const a = networkByApp();
    const all = [...appRows(a, null), ...remainderRows(a)];
    expect(all.reduce((n, r) => n + r.totalBytes, 0)).toBeCloseTo(
      a.iface_rx_bytes + a.iface_tx_bytes
    );
  });
});

describe("coverage", () => {
  it("partial: measured for 40 of 90 s", () => {
    expect(partialCoverage(networkByApp({ measured_ms: 40_000 }))).toEqual({
      measuredS: 40,
      spanS: 90,
    });
  });

  it("full coverage, within jitter, is not partial", () => {
    expect(partialCoverage(networkByApp())).toBeNull();
    expect(partialCoverage(networkByApp({ measured_ms: 89_400 }))).toBeNull();
  });

  it("an open bucket still filling is not missing time", () => {
    // The last bucket is open: the interface has its 10 s, the per-app
    // stream (on its own 10 s phase) only 4 s so far.
    const open = networkByApp({
      complete_to_ms: T + 80_000,
      measured_ms: 84_000,
    });
    expect(partialCoverage(open)).toBeNull();
    expect(openTailS(open)).toBe(10);
    expect(openTailS(networkByApp())).toBe(0);
  });

  it("time missing before the open part is reported once it closes", () => {
    // 50 s of the complete 80 s measured, and 4 s so far of the open bucket:
    // how much of the 54 s is the complete part's is not known yet.
    const open = networkByApp({
      complete_to_ms: T + 80_000,
      measured_ms: 54_000,
    });
    expect(partialCoverage(open)).toBeNull();
    const closed = networkByApp({ measured_ms: 60_000 });
    expect(partialCoverage(closed)).toEqual({ measuredS: 60, spanS: 90 });
  });

  it("a range with nothing complete yet is not partial", () => {
    expect(
      partialCoverage(
        networkByApp({ complete_to_ms: T - 10_000, measured_ms: 2_000 })
      )
    ).toBeNull();
    expect(openTailS(networkByApp({ complete_to_ms: T - 10_000 }))).toBe(90);
  });

  it("nothing recorded, and where recording starts", () => {
    const empty = networkByApp({
      measured_ms: 0,
      apps: [],
      coverage: [{ from_ms: T, to_ms: T + 90_000, tier: null }],
    });
    expect(unrecorded(empty)).toBe(true);
    expect(firstRecordedMs(empty)).toBeNull();
    expect(unrecorded(networkByApp())).toBe(false);
    expect(
      firstRecordedMs(
        networkByApp({
          coverage: [
            { from_ms: T, to_ms: T + 40_000, tier: null },
            { from_ms: T + 40_000, to_ms: T + 90_000, tier: "s10" },
          ],
        })
      )
    ).toBe(T + 40_000);
  });
});
