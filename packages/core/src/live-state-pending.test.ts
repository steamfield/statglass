import type { LiveMsg } from "@core/generated/bindings";
import { statusMsg } from "@tests/live-frames";
import {
  awaitHistory,
  clearRows,
  type HostLive,
  initialHostLive,
  reduceLive,
  ringLoading,
  SeriesColumns,
  settleSubscribe,
} from "./live-state";

const HOUR = 3_600_000;
const layout: LiveMsg = {
  kind: "layout",
  layout_no: 1,
  series: [{ metric: "cpu.total", labels: [] }],
  kinds: ["gauge"],
};
const plan = (
  recent_rows: number,
  earlier_start_ms: number | null
): LiveMsg => ({
  kind: "backfill_plan",
  recent_rows,
  earlier_start_ms,
});
function rows(
  kind: "backfill" | "backfill_earlier",
  start_ms: number,
  count: number,
  timeline = 0
): Extract<LiveMsg, { kind: "backfill" | "backfill_earlier" }> {
  const body = {
    layout_no: 1,
    start_ms,
    interval_ms: 1000,
    rows: Array.from({ length: count }, () => [1]),
    holds_ms: [2500],
  };
  return kind === "backfill" ? { kind, timeline, ...body } : { kind, ...body };
}
const frame = (ts_ms: number, timeline = 0): LiveMsg => ({
  kind: "frame",
  ts_ms,
  timeline,
  layout_no: 1,
  values: [2],
  held: [2],
});
function empty(capacity?: number): HostLive {
  const s = reduceLive(initialHostLive("host"), layout);
  return capacity === undefined
    ? s
    : { ...s, columns: new SeriesColumns(capacity) };
}
const apply = (s: HostLive, ...msgs: LiveMsg[]) => msgs.reduce(reduceLive, s);

it("initial state is not loading without a subscription", () => {
  expect(ringLoading(initialHostLive("h"), HOUR)).toBe(false);
});
it("awaits an empty subscribe and keeps its object on repeated calls", () => {
  const s = awaitHistory(empty());
  expect(s.historyPending).toBe("subscribe");
  expect(ringLoading(s, HOUR)).toBe(true);
  expect(awaitHistory(s)).toBe(s);
});
it("does not await a subscribe when rows are already held", () => {
  const s = apply(empty(), rows("backfill", 1000, 2));
  expect(awaitHistory(s)).toBe(s);
  expect(ringLoading(s, HOUR)).toBe(false);
});
it("settles only a subscribe that has not received its plan", () => {
  const s = awaitHistory(empty());
  expect(settleSubscribe(s).historyPending).toBeNull();
  for (const p of [plan(2, null), plan(2, 0)]) {
    const armed = reduceLive(s, p);
    expect(settleSubscribe(armed)).toBe(armed);
  }
  const initial = empty();
  expect(settleSubscribe(initial)).toBe(initial);
});
it("waits for recent backfill, then settles", () => {
  const s = apply(empty(), plan(2, null));
  expect(s.historyPending).toEqual({ recent: 2 });
  expect(ringLoading(s, HOUR)).toBe(true);
  expect(reduceLive(s, rows("backfill", 1000, 2)).historyPending).toBeNull();
});
it("a frame settles the promised recent rows", () => {
  const s = apply(empty(), plan(2, null), frame(3000));
  expect(s.historyPending).toBeNull();
});
it("a plan with nothing to send settles an empty subscribe", () => {
  expect(apply(awaitHistory(empty()), plan(0, null)).historyPending).toBeNull();
});
it("waits for earlier chunks until the promised oldest row lands", () => {
  let s = apply(empty(), plan(2, 0), rows("backfill", 10_000, 2));
  expect(s.historyPending).toBe(0);
  s = reduceLive(s, rows("backfill_earlier", 5000, 5));
  expect(s.historyPending).toBe(0);
  s = reduceLive(s, rows("backfill_earlier", 0, 5));
  expect(s.historyPending).toBeNull();
});
it("a late subscribe reply never undoes a plan or interrupts its loading", () => {
  let s = awaitHistory(empty());
  for (const m of [
    plan(2, 0),
    rows("backfill", 10_000, 2),
    rows("backfill_earlier", 5000, 5),
  ]) {
    expect(ringLoading(s, HOUR)).toBe(true);
    s = reduceLive(s, m);
    expect(ringLoading(s, HOUR)).toBe(true);
  }
  s = reduceLive(s, rows("backfill_earlier", 0, 5));
  expect(s.historyPending).toBeNull();
  expect(settleSubscribe(s)).toBe(s);
});
it("a reply reporting rows before any message keeps waiting through the last chunk", () => {
  let s = awaitHistory(empty());
  // The successful nonempty reply does not settle the subscribe.
  for (const m of [
    plan(2, 0),
    rows("backfill", 10_000, 2),
    rows("backfill_earlier", 5000, 5),
  ]) {
    s = reduceLive(s, m);
    expect(ringLoading(s, HOUR)).toBe(true);
  }
  s = reduceLive(s, rows("backfill_earlier", 0, 5));
  expect(ringLoading(s, HOUR)).toBe(false);
});
it("settles when the ring fills before the promised start", () => {
  const s = apply(
    empty(4),
    plan(2, 0),
    rows("backfill", 10_000, 2),
    rows("backfill_earlier", 5000, 5)
  );
  expect(s.columns.firstTsMs()).toBe(8000);
  expect(s.historyPending).toBeNull();
});
it("an overlapping chunk that writes nothing still settles a reached target", () => {
  const held = apply(empty(), rows("backfill", 1000, 3));
  const pending = { ...held, historyPending: 1000 };
  const s = reduceLive(pending, rows("backfill_earlier", 1000, 3));
  expect(s.historyPending).toBeNull();
  expect(s.rowsVersion).toBe(pending.rowsVersion);
  expect(reduceLive(s, rows("backfill_earlier", 1000, 3))).toBe(s);
});
it("a chunk that writes nothing into a full ring settles an unreached target", () => {
  const held = apply(empty(2), rows("backfill", 10_000, 2));
  const pending = { ...held, historyPending: 0 };
  expect(
    reduceLive(pending, rows("backfill_earlier", 0, 2)).historyPending
  ).toBeNull();
});
it("a resubscribe plan leaves an already populated ring visible", () => {
  const held = apply(empty(), rows("backfill", 10_000, 2));
  expect(reduceLive(held, plan(2, 0))).toBe(held);
  expect(ringLoading(held, HOUR)).toBe(false);
});
it("a plan cancelling older history clears its promise", () => {
  const s = apply(
    empty(),
    plan(2, 0),
    rows("backfill", 10_000, 2),
    plan(2, null)
  );
  expect(s.historyPending).toBeNull();
});
it("a recent-only plan clears subscribe and recent markers on a populated ring", () => {
  for (const historyPending of ["subscribe", { recent: 2 }] as const) {
    const held = apply(empty(), rows("backfill", 1000, 2));
    expect(
      reduceLive({ ...held, historyPending }, plan(2, null)).historyPending
    ).toBeNull();
  }
});
it("the first timeline preserves the promise", () => {
  const s = apply(
    awaitHistory(empty()),
    plan(2, 0),
    rows("backfill", 10_000, 2)
  );
  expect(s.historyPending).toBe(0);
});
it.each([5000, 20_000])(
  "a changed timeline clears the promise even with no truncation (%i)",
  (ts) => {
    const s = apply(
      empty(),
      plan(2, 0),
      rows("backfill", 10_000, 2),
      frame(ts, 1)
    );
    expect(s.historyPending).toBeNull();
  }
);
it("clearing rows preserves what is still promised", () => {
  const s = apply(empty(), plan(2, 0), rows("backfill", 10_000, 2));
  expect(clearRows(s).historyPending).toBe(0);
});
it("does not load while reconnecting", () => {
  expect(
    ringLoading({ ...awaitHistory(empty()), connection: "reconnecting" }, HOUR)
  ).toBe(false);
});
it("does not load while the display sleeps", () => {
  const s = apply(awaitHistory(empty()), statusMsg({ display_idle: true }));
  expect(ringLoading(s, HOUR)).toBe(false);
});
it("covers a five minute window before the whole hour is filled", () => {
  const s = apply(empty(), plan(601, 0), rows("backfill", 3_000_000, 601));
  expect(ringLoading(s, HOUR)).toBe(true);
  expect(ringLoading(s, 300_000)).toBe(false);
});
it("honours bucket tolerance rather than the one-second default", () => {
  const s = apply(
    empty(),
    plan(1, 0),
    rows("backfill", HOUR, 1),
    rows("backfill_earlier", 15_000, 1)
  );
  expect(ringLoading(s, HOUR)).toBe(true);
  expect(ringLoading(s, HOUR, 15_000)).toBe(false);
});

it("counts every recent segment before revealing", () => {
  let s = apply(empty(), plan(5, null));
  s = reduceLive(s, rows("backfill", 1000, 2));
  expect(ringLoading(s, HOUR)).toBe(true);
  expect(s.historyPending).toEqual({ recent: 3 });
  s = reduceLive(s, rows("backfill", 5000, 3));
  expect(ringLoading(s, HOUR)).toBe(false);
  expect(s.historyPending).toBeNull();
});
it("a frame settles partially received recent segments", () => {
  let s = apply(empty(), plan(5, null), rows("backfill", 1000, 2));
  expect(ringLoading(s, HOUR)).toBe(true);
  s = reduceLive(s, frame(3000));
  expect(s.historyPending).toBeNull();
});
it("a recent-only replacement plan keeps a cleared ring loading", () => {
  const s = clearRows(apply(empty(), plan(2, 0), rows("backfill", 1000, 2)));
  const next = reduceLive(s, plan(3, null));
  expect(next.historyPending).toEqual({ recent: 3 });
  expect(ringLoading(next, HOUR)).toBe(true);
});
it("a recent-only replacement cancels numeric pending with data or no rows promised", () => {
  const held = apply(empty(), plan(2, 0), rows("backfill", 1000, 2));
  expect(reduceLive(held, plan(3, null)).historyPending).toBeNull();
  const cleared = clearRows(held);
  expect(reduceLive(cleared, plan(0, null)).historyPending).toBeNull();
});
it.each(["unknown layout", "empty rows"])(
  "an unapplied oldest chunk settles: %s",
  (reason) => {
    const s = { ...empty(), historyPending: 1000 };
    const chunk = {
      ...rows("backfill_earlier", 500, reason === "empty rows" ? 0 : 2),
      layout_no: reason === "unknown layout" ? 99 : 1,
    };
    const next = reduceLive(s, chunk);
    expect(next.historyPending).toBeNull();
    expect(next.rowsVersion).toBe(s.rowsVersion);
    expect(reduceLive(next, chunk)).toBe(next);
    expect(reduceLive(s, { ...chunk, start_ms: 2000 })).toBe(s);
  }
);
