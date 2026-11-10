import type { LiveMsg } from "@core/generated/bindings";
import { MockChannels } from "./channels";
import { MockCommands } from "./commands";
import type { LiveSub } from "./contracts";
import { createMockEmitters } from "./emitters";
import { scenarioFlags } from "./fixtures";
import { MockPower } from "./power";
import { MockRing } from "./ring";
import { MockSettings } from "./settings";

it("a clock step reuses the last layout when the series have not changed", () => {
  const flags = scenarioFlags([]);
  const emitters = createMockEmitters();
  const ring = new MockRing(flags, () => 100_000, { historyRows: 60 });
  const power = new MockPower(
    new MockSettings({}, flags, new MockCommands(), emitters),
    emitters,
    flags,
    {}
  );
  const channels = new MockChannels(ring, power);
  const messages: LiveMsg[] = [];
  const sub: LiveSub = {
    onMsg: (m) => messages.push(m),
    stream: 1,
    pick: null,
    series: ring.gen.keys,
    layoutNo: null,
    minPeriodMs: null,
    lastFrameMs: null,
    backfillMs: 60_000,
    lastSentMs: null,
    sentTimeline: null,
    earlier: [],
    earlierStarted: false,
    timer: null,
    queue: [],
    queueTimer: null,
    holdsSent: null,
    statusSent: null,
  };
  channels.fresh(sub);
  messages.length = 0;
  ring.timeline++;
  const row = ring.gen.next();
  ring.pushRow(50_000, row.values, row.cadences, 1000);
  channels.catchUpStep(sub);
  expect(messages.map((m) => m.kind)).toEqual(["backfill_plan", "backfill"]);
  expect(messages[0]).toEqual({
    kind: "backfill_plan",
    recent_rows: 1,
    earlier_start_ms: null,
  });
  channels.dispose();
});
