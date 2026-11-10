import type { LiveMsg } from "@core/generated/bindings";
import type { HistoryRow, LiveSub } from "./contracts";
import type { MockPower } from "./power";
import {
  chunked,
  EARLIER_AFTER_MS,
  effectiveMinPeriodMs,
  framePeriodMs,
  layoutMsg,
  project,
  RECENT_MS,
  segments,
} from "./protocol";
import type { MockRing } from "./ring";
export class MockChannels {
  readonly live = new Map<(msg: LiveMsg) => void, LiveSub>();
  constructor(
    private readonly ring: MockRing,
    private readonly power: MockPower
  ) {}
  readonly push = (msg: LiveMsg) => {
    for (const cb of [...this.live.keys()]) cb(msg);
  };
  readonly statusFor = (sub: LiveSub): LiveMsg => ({
    kind: "status",
    ...this.power.status,
    frame_period_ms: framePeriodMs(
      this.power.status.interval_ms,
      effectiveMinPeriodMs(sub.minPeriodMs, this.power.status.performance)
    ),
  });
  readonly sendStatus = (sub: LiveSub) => {
    const msg = this.statusFor(sub);
    const key = JSON.stringify(msg);
    if (sub.statusSent === key) return;
    sub.statusSent = key;
    sub.onMsg(msg);
  };
  readonly pushStatus = () => {
    if (!this.power.windowVisible) return;
    for (const sub of [...this.live.values()]) this.sendStatus(sub);
  };
  readonly rowsMsg = (
    kind: "backfill" | "backfill_earlier",
    seg: HistoryRow[],
    sub: LiveSub
  ): LiveMsg => {
    const first = seg[0] as HistoryRow;
    const body = {
      layout_no: this.ring.layoutNo,
      start_ms: first.ts,
      interval_ms: first.interval,
      rows: seg.map((r) => project(r.values, sub.pick)),
      holds_ms: project(first.holds, sub.pick),
    };
    if (kind === "backfill_earlier") return { kind, ...body };
    const last = seg[seg.length - 1] as HistoryRow;
    sub.lastSentMs = Math.max(sub.lastSentMs ?? last.ts, last.ts);
    sub.sentTimeline = last.timeline;
    return { kind, timeline: first.timeline, ...body };
  };
  readonly deliver = (sub: LiveSub, msg: LiveMsg) => {
    if (sub.queue.length === 0) {
      sub.onMsg(msg);
      return;
    }
    sub.queue.push(msg);
  };
  readonly sendLayout = (sub: LiveSub) => {
    if (sub.layoutNo === this.ring.layoutNo) return;
    this.deliver(sub, layoutMsg(this.ring.layoutNo, sub.series));
    sub.layoutNo = this.ring.layoutNo;
  };
  readonly drainQueue = (sub: LiveSub) => {
    if (sub.queueTimer !== null) return;
    const next = () => {
      sub.queueTimer = null;
      if (!this.power.windowVisible) return;
      const msg = sub.queue.shift();
      if (!msg || !this.live.has(sub.onMsg)) return;
      sub.onMsg(msg);
      if (sub.queue.length > 0) sub.queueTimer = setTimeout(next, 0);
    };
    sub.queueTimer = setTimeout(next, 0);
  };
  readonly resume = () => {
    // Rust's catch-up sends the status in effect first (deduped), so whatever
    // changed while hidden (pause, power) arrives on show. The open-time
    // sample Rust may take (D-094) is not modelled: rows stay on the grid.
    for (const sub of this.live.values()) this.sendStatus(sub);
    const newest = this.ring.rows[this.ring.rows.length - 1]?.ts;
    if (newest === undefined) return;
    for (const sub of this.live.values()) {
      if (sub.lastSentMs === null) {
        this.fresh(sub);
        continue;
      }
      sub.queue.push(...this.missed(sub));
      if (sub.queue.length > 0) this.drainQueue(sub);
      if (sub.timer === null) this.sendEarlier(sub);
    }
  };
  readonly catchUpStep = (sub: LiveSub) => {
    if (sub.sentTimeline === null || sub.sentTimeline === this.ring.timeline)
      return;
    for (const msg of this.missed(sub)) this.deliver(sub, msg);
  };
  readonly missed = (sub: LiveSub): LiveMsg[] => {
    const newest = this.ring.rows[this.ring.rows.length - 1]?.ts;
    if (newest === undefined) return [];
    const floor = newest - sub.backfillMs;
    const held = sub.sentTimeline;
    const stepped = held !== null && held !== this.ring.timeline;
    const after = sub.lastSentMs ?? Number.NEGATIVE_INFINITY;
    const missed = this.ring.rows.filter(
      (r) => r.ts > floor && (stepped ? r.timeline !== held : r.ts > after)
    );
    const messages: LiveMsg[] = [];
    if (stepped) {
      sub.earlier = [];
      messages.push(
        {
          kind: "backfill_plan",
          recent_rows: missed.length,
          earlier_start_ms: null,
        },
        layoutMsg(this.ring.layoutNo, sub.series)
      );
      sub.layoutNo = this.ring.layoutNo;
    }
    for (const seg of segments(missed)) {
      for (const chunk of chunked(seg))
        messages.push(this.rowsMsg("backfill", chunk, sub));
    }
    return messages;
  };
  readonly fresh = (sub: LiveSub) => {
    const h = this.history(sub, sub.backfillMs);
    sub.earlier = h.earlier;
    this.sendStatus(sub);
    if (h.earlier.length > 0) this.sendLayout(sub);
    if (this.ring.rows.length > 0)
      sub.onMsg({
        kind: "backfill_plan",
        recent_rows: h.recentRows,
        earlier_start_ms: h.earlierStart,
      });
    if (h.recentRows > 0) this.sendLayout(sub);
    for (const msg of h.recent) sub.onMsg(msg);
    if (sub.earlier.length > 0) {
      sub.timer = setTimeout(() => {
        sub.timer = null;
        this.sendEarlier(sub);
      }, EARLIER_AFTER_MS);
    }
    return h;
  };
  readonly history = (sub: LiveSub, backfillMs: number) => {
    const newest =
      this.ring.rows[this.ring.rows.length - 1]?.ts ??
      this.ring.now() + this.ring.clockOffset;
    const inWindow = this.ring.rows.filter((r) => r.ts >= newest - backfillMs);
    const recentFrom = newest - RECENT_MS;
    const recent = segments(inWindow.filter((r) => r.ts >= recentFrom));
    const older = segments(inWindow.filter((r) => r.ts < recentFrom));
    const chunks: HistoryRow[][] = [];
    for (const seg of older) chunks.push(...chunked(seg));
    // Newest first: Rust chunks each segment from its start, then reverses delivery.
    chunks.sort((a, b) => (b[0] as HistoryRow).ts - (a[0] as HistoryRow).ts);
    return {
      recentRows: recent.reduce((n, seg) => n + seg.length, 0),
      recent: recent.map((seg) => this.rowsMsg("backfill", seg, sub)),
      earlier: chunks.map((seg) => this.rowsMsg("backfill_earlier", seg, sub)),
      earlierRows: chunks.reduce((n, c) => n + c.length, 0),
      earlierStart: chunks.length
        ? (chunks[chunks.length - 1]?.[0]?.ts ?? null)
        : null,
    };
  };
  readonly sendEarlier = (sub: LiveSub) => {
    if (
      sub.earlierStarted ||
      !this.power.receiving() ||
      sub.earlier.length === 0
    )
      return;
    sub.earlierStarted = true;
    const next = () => {
      sub.timer = null;
      if (!this.power.receiving()) {
        sub.earlierStarted = false;
        return;
      }
      const chunk = sub.earlier.shift();
      if (!chunk || !this.live.has(sub.onMsg)) return;
      sub.onMsg(chunk);
      sub.timer = setTimeout(next, 0);
    };
    if (sub.timer !== null) clearTimeout(sub.timer);
    sub.timer = setTimeout(next, 0);
  };
  dispose() {
    for (const sub of this.live.values()) {
      if (sub.timer !== null) clearTimeout(sub.timer);
      if (sub.queueTimer !== null) clearTimeout(sub.queueTimer);
    }
    this.live.clear();
  }
}
