import type { ProcessView } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import type { RunningApps } from "@core/process-groups";
import { act, waitFor } from "@testing-library/react";
import { liveProcess } from "@tests/fixtures/processes";
import { renderWithProviders } from "@tests/test-utils";
import { describe, expect, it } from "vitest";
import { RUNNING_APPS_VIEW } from "~/hooks/use-running-apps";
import { useRunningApps } from "./use-running-apps";

type Transport = ReturnType<typeof createMockTransport>;

const views = (t: Transport) =>
  t.calls
    .filter((c) => c.command === "set_process_interest")
    .map((c) => c.args[2] as ProcessView | null);

function mount(scenarios: "appstore"[] = []) {
  const transport = createMockTransport({ scenarios, autoTick: false });
  const seen: (RunningApps | null)[] = [];
  function Probe() {
    seen.push(useRunningApps());
    return null;
  }
  renderWithProviders(<Probe />, { transport });
  return { transport, seen };
}

const xcode = liveProcess({ pid: 1, name: "Xcode", app: "Xcode" });
const helper = liveProcess({ pid: 2, name: "SourceKitService", app: "Xcode" });
const node = liveProcess({ pid: 3, name: "node", app: "node" });

function push(t: Transport, ts: number, rows = [xcode, helper, node]) {
  act(() => t.push({ kind: "processes", ts_ms: ts, rows }));
}

describe("useRunningApps", () => {
  it("asks for the full table and maps running processes by app", async () => {
    const { transport, seen } = mount();
    expect(seen.at(-1)).toBeNull();
    await waitFor(() =>
      expect(views(transport)).toContainEqual(RUNNING_APPS_VIEW)
    );
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    push(transport, 1000);
    const running = seen.at(-1);
    expect(running?.get("Xcode")?.map((p) => p.pid)).toEqual([1, 2]);
    expect(running?.get("node")?.map((p) => p.pid)).toEqual([3]);
  });

  it("keeps the map and skips renders while membership holds", async () => {
    const { transport, seen } = mount();
    await waitFor(() =>
      expect(views(transport)).toContainEqual(RUNNING_APPS_VIEW)
    );
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    push(transport, 1000);
    const first = seen.at(-1);
    expect(first).not.toBeNull();
    const renders = seen.length;
    push(transport, 2000, [{ ...xcode, cpu_pct: 90 }, helper, node]);
    expect(seen.length).toBe(renders);
    expect(seen.at(-1)).toBe(first);
    push(transport, 3000, [xcode, helper]);
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.has("node")).toBe(false);
  });

  it("asks for nothing and stays null where Quit is not offered", async () => {
    const { transport, seen } = mount(["appstore"]);
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
