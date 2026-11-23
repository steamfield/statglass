import type { ProcessView } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import { act, waitFor } from "@testing-library/react";
import { liveProcess } from "@tests/fixtures/processes";
import { renderWithProviders } from "@tests/test-utils";
import { describe, expect, it } from "vitest";
import {
  type AppQuitTargets,
  RUNNING_APPS_VIEW,
  type RunningMatches,
  useAppQuitTargets,
  useRunningMatches,
} from "./use-running-apps";

type Transport = ReturnType<typeof createMockTransport>;

const views = (t: Transport) =>
  t.calls
    .filter((c) => c.command === "set_process_interest")
    .map((c) => c.args[2] as ProcessView | null);

const xcode = liveProcess({
  pid: 1,
  name: "Xcode",
  app: "Xcode",
  app_quit: true,
});
const helper = liveProcess({
  pid: 2,
  name: "SourceKitService",
  app: "Xcode",
  app_quit: false,
});
const node = liveProcess({ pid: 3, name: "node", app: "node", app_quit: true });
const terminal = liveProcess({
  pid: 4,
  name: "Terminal",
  app: "Terminal",
  app_quit: true,
});

const LISTED = ["Xcode", "Safari"] as const;

/** Renders a probe that records every answer `use` gives, render by render. */
function mount<T>(use: () => T, scenarios: "appstore"[] = []) {
  const transport = createMockTransport({ scenarios, autoTick: false });
  const seen: T[] = [];
  function Probe() {
    seen.push(use());
    return null;
  }
  renderWithProviders(<Probe />, { transport });
  return { transport, seen };
}

async function ready(t: Transport) {
  await waitFor(() => expect(views(t)).toContainEqual(RUNNING_APPS_VIEW));
  await waitFor(() => expect(t.subscriberCount()).toBe(1));
}

function push(t: Transport, ts: number, rows = [xcode, helper, node]) {
  act(() => t.push({ kind: "processes", ts_ms: ts, rows }));
}

const pids = (targets: AppQuitTargets | null | undefined, app: string) =>
  targets?.get(app)?.map((p) => p.pid);

describe("useAppQuitTargets", () => {
  it("asks for the full table and gives each listed app's quit targets", async () => {
    const { transport, seen } = mount(() => useAppQuitTargets(LISTED));
    expect(seen.at(-1)).toBeNull();
    await ready(transport);
    push(transport, 1000);
    const targets = seen.at(-1);
    expect(pids(targets, "Xcode")).toEqual([1]);
    // Listed but not running: nothing to quit.
    expect(pids(targets, "Safari")).toEqual([]);
    // Not listed: not in the answer.
    expect(targets?.has("node")).toBe(false);
  });

  it("does not render while the listed apps' targets hold", async () => {
    const { transport, seen } = mount(() => useAppQuitTargets(LISTED));
    await ready(transport);
    push(transport, 1000);
    const first = seen.at(-1);
    const renders = seen.length;
    // New figures, and an unlisted app starting and another exiting.
    push(transport, 2000, [{ ...xcode, cpu_pct: 90 }, helper, terminal]);
    expect(seen.length).toBe(renders);
    // A listed app's targets changing gives a new answer.
    push(transport, 3000, [helper, terminal]);
    expect(seen.at(-1)).not.toBe(first);
    expect(pids(seen.at(-1), "Xcode")).toEqual([]);
  });

  it("asks for nothing and stays null where Quit is not offered", async () => {
    const { transport, seen } = mount(
      () => useAppQuitTargets(LISTED),
      ["appstore"]
    );
    await waitFor(() =>
      expect(transport.calls.some((c) => c.command === "get_edition")).toBe(
        true
      )
    );
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    push(transport, 1000);
    expect(views(transport)).not.toContainEqual(RUNNING_APPS_VIEW);
    expect(seen.every((m) => m === null)).toBe(true);
  });
});

describe("useRunningMatches", () => {
  const recorded = [
    { pid: 2, start_time_us: helper.start_time_us },
    // Same pid, another start: a process that exited and whose pid was reused.
    { pid: 3, start_time_us: node.start_time_us + 1 },
  ];

  it("matches listed processes by pid and start time", async () => {
    const { transport, seen } = mount(() => useRunningMatches(recorded));
    expect(seen.at(-1)).toBeNull();
    await ready(transport);
    push(transport, 1000);
    const matches: RunningMatches | null | undefined = seen.at(-1);
    expect([...(matches?.values() ?? [])].map((p) => p.pid)).toEqual([2]);
  });

  it("does not render while the listed processes' matches hold", async () => {
    const { transport, seen } = mount(() => useRunningMatches(recorded));
    await ready(transport);
    push(transport, 1000);
    const renders = seen.length;
    push(transport, 2000, [xcode, { ...helper, cpu_pct: 50 }, terminal]);
    expect(seen.length).toBe(renders);
    push(transport, 3000, [xcode, terminal]);
    expect(seen.at(-1)?.size).toBe(0);
  });
});
