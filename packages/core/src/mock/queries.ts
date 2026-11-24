import type {
  ExportOutcome,
  HistoryRequest,
  RemoteHostStatus,
} from "@core/generated/bindings";
import { HISTORY_TIERS, METRIC_MODULES } from "@core/generated/bindings";
import { DAY_MS } from "@core/time-grid";
import type { MockCommands } from "./commands";
import type { MockTransport, MockTransportOptions } from "./contracts";
import { mockDiskDevices, mockDiskIo } from "./disk-io";
import type { createMockDocker } from "./docker";
import { hostRecord, MOCK_HOST_ID } from "./fixtures";
import { mockHeatmap } from "./heatmap";
import {
  mockGaps,
  mockHistory,
  mockRecentHistory,
  mockSeriesStats,
} from "./history";
import { NET_MAX_SPAN_MS } from "./net-apps";
import type { MockPower } from "./power";
import { fail, invalid, ok, STORE } from "./protocol";
import type { MockRemotes } from "./remote";
import type { MockRing } from "./ring";
import type { MockStore } from "./store";
export class MockQueries {
  constructor(
    private readonly options: MockTransportOptions,
    private readonly ring: MockRing,
    private readonly power: MockPower,
    private readonly store: MockStore,
    private readonly remote: MockRemotes,
    private readonly commands: MockCommands,
    private readonly docker: ReturnType<typeof createMockDocker>
  ) {}
  readonly historyPage = (req: HistoryRequest) =>
    this.store.unavailable
      ? mockRecentHistory(
          req,
          this.ring.gen.specs,
          this.ring.now(),
          this.power.status.interval_ms
        )
      : mockHistory(
          req,
          this.ring.gen.specs,
          mockGaps(this.ring.flags, this.ring.startMs),
          this.ring.now(),
          this.power.status.interval_ms
        );
  readonly listDiskIoDevices: MockTransport["listDiskIoDevices"] = async (
    host
  ) => {
    if (this.remote.remotes.has(host)) {
      this.commands.record("list_disk_io_devices", host);
      return fail({ kind: "remote_host", host });
    }
    return this.commands.hostCommand(
      "list_disk_io_devices",
      host,
      [host],
      {},
      () => ok(mockDiskDevices(this.options.scenarios ?? []))
    );
  };
  readonly queryDiskIo: MockTransport["queryDiskIo"] = async (request) =>
    this.remote.forward(request.host, (peer) => {
      this.commands.record("query_disk_io", request);
      return peer.queryDiskIo({ ...request, host: MOCK_HOST_ID });
    }) ??
    this.commands.hostCommand(
      "query_disk_io",
      request.host,
      [request],
      {
        range: [request.from_ms, request.to_ms],
        maxSpanMs: NET_MAX_SPAN_MS,
      },
      () =>
        ok(
          mockDiskIo(
            request,
            this.options.scenarios ?? [],
            mockGaps(this.ring.flags, this.ring.startMs)
          )
        )
    );
  readonly queryHistory: MockTransport["queryHistory"] = async (request) => {
    if ((this.options.latencyMs ?? 0) > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.latencyMs)
      );
    return (
      this.remote.forward(request.host, async (peer) => {
        const until = mirroredUntil(
          this.remote.remotes.get(request.host)?.record.status
        );
        const result = await peer.queryHistory({
          ...request,
          host: MOCK_HOST_ID,
        });
        if (until === null || result.status === "error") return result;
        return ok({
          ...result.data,
          series: result.data.series.map((series) => ({
            ...series,
            points: series.points.filter((point) => point.t <= until),
          })),
        });
      }) ??
      this.commands.hostCommand(
        "query_history",
        request.host,
        [request],
        { range: [request.from_ms, request.to_ms] },
        () => {
          if (request.selectors.length === 0) return invalid("empty selectors");
          // With history unavailable Rust answers from the engine's recent
          // rows (`HISTORY_RECENT_MS`). Gaps sit where the ring has its holes:
          // fixed at start, not sliding.
          return ok(this.historyPage(request));
        }
      )
    );
  };
  /** As `History::last_wake`: the latest closed sleep in the past week. */
  readonly lastWake: MockTransport["lastWake"] = async (host) =>
    this.remote.forward(host, (peer) => peer.lastWake(MOCK_HOST_ID)) ??
    this.commands.hostCommand(
      "last_wake",
      host,
      [host],
      { needsHistory: true },
      () => {
        const now = this.ring.now();
        let wake: number | null = null;
        for (const g of mockGaps(this.ring.flags, this.ring.startMs)) {
          if (g.reason !== "sleep" || g.end_ms === null) continue;
          if (g.end_ms < now - 7 * DAY_MS || g.start_ms > now) continue;
          wake = Math.max(wake ?? g.end_ms, g.end_ms);
        }
        return ok(wake);
      }
    );
  readonly querySeriesStats: MockTransport["querySeriesStats"] = async (
    host,
    metrics,
    fromMs,
    toMs
  ) => {
    const forwarded = this.remote.forward(host, (peer) =>
      peer.querySeriesStats(MOCK_HOST_ID, metrics, fromMs, toMs)
    );
    if (forwarded) return forwarded;
    const args = [host, metrics, fromMs, toMs];
    const checks = {
      range: [fromMs, toMs],
      maxSpanMs: NET_MAX_SPAN_MS,
    } as const;
    return this.commands.hostCommand(
      "query_series_stats",
      host,
      args,
      checks,
      () => {
        // As Rust: series stats take unlabelled catalog metrics only.
        for (const m of metrics) {
          if (!(m in METRIC_MODULES))
            return invalid(`${m} is not in the catalog`);
          if (
            this.ring.gen.keys.some(
              (k) => k.metric === m && k.labels.length > 0
            )
          ) {
            return invalid(
              `${m} has labels; series stats take unlabelled metrics`
            );
          }
        }
        return ok(
          mockSeriesStats(
            host,
            metrics,
            fromMs,
            toMs,
            this.ring.now(),
            this.historyPage
          )
        );
      }
    );
  };
  readonly queryEvents: MockTransport["queryEvents"] = async (
    host,
    fromMs,
    toMs
  ) =>
    this.remote.forward(host, (peer) =>
      peer.queryEvents(MOCK_HOST_ID, fromMs, toMs)
    ) ??
    // The store's read: an empty range comes back empty.
    this.commands.hostCommand(
      "query_events",
      host,
      [host, fromMs, toMs],
      STORE,
      () =>
        ok(this.store.events.filter((e) => e.ts_ms >= fromMs && e.ts_ms < toMs))
    );
  readonly queryHeatmap: MockTransport["queryHeatmap"] = async (request) =>
    this.remote.forward(request.host, (peer) =>
      peer.queryHeatmap({ ...request, host: MOCK_HOST_ID })
    ) ??
    this.commands.hostCommand(
      "query_heatmap",
      request.host,
      [request],
      STORE,
      () =>
        request.days.some((d) => d.hour_starts.length !== 25)
          ? invalid("every day needs 25 hour boundaries")
          : ok(mockHeatmap(request, this.ring.now()))
    );
  readonly exportCsv: MockTransport["exportCsv"] = async (request) => {
    return this.commands.hostCommand<ExportOutcome>(
      "export_csv",
      request.host,
      [request],
      { ...STORE, range: [request.from_ms, request.to_ms] },
      () => {
        if (request.selectors.length === 0)
          return invalid("no series selected");
        if (this.options.exportCancels) return ok({ kind: "cancelled" });
        // One row per bucket of the tier `auto` would read (D-076), gaps apart.
        const span = request.to_ms - request.from_ms;
        const tierMs = exportTier(request.tier, span);
        const gapRows = mockGaps(this.ring.flags, this.ring.startMs).filter(
          (g) =>
            g.start_ms < request.to_ms &&
            (g.end_ms ?? Infinity) > request.from_ms
        ).length;
        const rows = Math.ceil(span / tierMs);
        return ok({
          kind: "saved",
          path: `/Users/mock/Downloads/${request.file_name ?? "statglass-history.csv"}`,
          rows,
          gap_rows: gapRows,
          bytes: 64 + rows * 24 * (1 + request.selectors.length * 3),
        });
      }
    );
  };
  readonly historySize: MockTransport["historySize"] = async (host) =>
    this.remote.forward(host, (peer) => peer.historySize(MOCK_HOST_ID)) ??
    this.commands.hostCommand("history_size", host, [host], STORE, () =>
      ok(this.store.historyBytes)
    );
  readonly historyGrowth: MockTransport["historyGrowth"] = async (host) =>
    this.remote.forward(host, (peer) => peer.historyGrowth(MOCK_HOST_ID)) ??
    this.commands.hostCommand("history_growth", host, [host], STORE, () =>
      ok(this.store.growth)
    );
  readonly clearHistory: MockTransport["clearHistory"] = async (host) => {
    return this.commands.hostCommand(
      "clear_history",
      host,
      [host],
      STORE,
      () => {
        this.store.historyBytes = 0;
        this.store.growth = null;
        if (this.store.health.trimmed_before_ms !== null) {
          this.store.setHistoryHealth({
            ...this.store.health,
            trimmed_before_ms: null,
            trimmed_limit_bytes: null,
            cap_met: true,
          });
        }
        return ok(this.store.historyBytes);
      }
    );
  };
  readonly historyHealth: MockTransport["historyHealth"] = async (host) =>
    this.remote.forward(host, (peer) => peer.historyHealth(MOCK_HOST_ID)) ??
    this.commands.hostCommand("history_health", host, [host], STORE, () =>
      ok(this.store.health)
    );
  readonly resetHistory: MockTransport["resetHistory"] = async () => {
    this.commands.record("reset_history");
    // Another StatGlass process holds the lock: a reset cannot take it.
    if (
      this.store.unavailable?.kind === "history_unavailable" &&
      this.store.unavailable.reason?.kind === "locked"
    ) {
      return fail({
        kind: "store_busy",
        message: "history.sqlite is locked by another StatGlass process",
      });
    }
    this.store.unavailable = null;
    this.docker.resetHistory();
    this.store.historyBytes = 4096;
    this.store.growth = null;
    this.store.setHistoryHealth({
      low_disk_paused: this.store.health.low_disk_paused,
      trimmed_before_ms: null,
      trimmed_limit_bytes: null,
      cap_met: true,
    });
    return ok(this.store.historyBytes);
  };
  readonly sensorDump: MockTransport["sensorDump"] = async (host) => {
    return this.commands.hostCommand("sensor_dump", host, [host], {}, () => {
      const info = hostRecord(this.ring.flags, this.ring.startMs).info;
      const last = this.ring.rows[this.ring.rows.length - 1]?.values ?? [];
      return ok({
        model: info.model,
        chip: info.chip,
        os_version: info.os_version,
        chip_known: info.chip_known,
        capabilities: this.ring.caps,
        sensors: this.ring.gen.specs
          .map((s, i) => ({ s, value: last[i] ?? null }))
          .filter(({ s }) => s.module === "power" || s.module === "sensors")
          .map(({ s, value }) => ({ key: s.key, value })),
      });
    });
  };

  get methods() {
    return {
      listDiskIoDevices: this.listDiskIoDevices,
      queryDiskIo: this.queryDiskIo,
      queryHistory: this.queryHistory,
      querySeriesStats: this.querySeriesStats,
      lastWake: this.lastWake,
      queryEvents: this.queryEvents,
      queryHeatmap: this.queryHeatmap,
      exportCsv: this.exportCsv,
      historySize: this.historySize,
      historyGrowth: this.historyGrowth,
      clearHistory: this.clearHistory,
      historyHealth: this.historyHealth,
      resetHistory: this.resetHistory,
      sensorDump: this.sensorDump,
    };
  }
}

/**
 * The last instant a remote's mirror holds samples for: its last-seen time while it
 * isn't connected, so later history is a gap as in Rust; null when connected.
 */
function mirroredUntil(status: RemoteHostStatus | undefined): number | null {
  if (!status || status.state === "connected") return null;
  return status.last_seen_ms ?? Number.NEGATIVE_INFINITY;
}

function exportTier(
  tier: Parameters<MockTransport["exportCsv"]>[0]["tier"],
  span: number
): number {
  const [s10, m1, m15] = HISTORY_TIERS;
  if (tier === "s10") return s10.bucket_ms;
  if (tier === "m1") return m1.bucket_ms;
  if (span <= s10.kept_ms) return s10.bucket_ms;
  if (span <= m1.kept_ms) return m1.bucket_ms;
  return m15.bucket_ms;
}
