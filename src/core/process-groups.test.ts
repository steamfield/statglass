import { describe, expect, it } from "vitest";
import { liveProcess } from "../../tests/fixtures/processes";
import {
  appQuitTargets,
  diskTotal,
  groupLiveProcesses,
  netTotal,
  runningByApp,
} from "./process-groups";

const chrome = liveProcess({
  pid: 10,
  name: "Google Chrome",
  app: "Google Chrome",
  app_quit: true,
  cpu_pct: 5,
  mem_bytes: 100,
  threads: 20,
  ports: [9222],
});
const renderer = liveProcess({
  pid: 11,
  name: "Google Chrome Helper (Renderer)",
  app: "Google Chrome",
  app_quit: false,
  cpu_pct: 3,
  mem_bytes: 50,
  threads: 10,
  ports: [],
});
const node1 = liveProcess({
  pid: 20,
  name: "node",
  app: "node",
  app_quit: true,
  cpu_pct: 1,
  mem_bytes: 10,
  ports: [3000, 5173],
});
const node2 = liveProcess({
  pid: 2214,
  name: "node",
  app: "node",
  app_quit: true,
  cpu_pct: null,
  mem_bytes: 20,
  ports: [3000],
  user: "root",
});
const xcode = liveProcess({
  pid: 30,
  name: "Xcode",
  app: "Xcode",
  app_quit: true,
  cpu_pct: 9,
});

const rows = [chrome, node1, renderer, xcode, node2];

describe("groupLiveProcesses", () => {
  it("groups by app in first-seen order and keeps member order", () => {
    const groups = groupLiveProcesses(rows, "");
    expect(groups.map((g) => g.name)).toEqual([
      "Google Chrome",
      "node",
      "Xcode",
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      "app:Google Chrome",
      "app:node",
      "app:Xcode",
    ]);
    expect(groups[0]?.members.map((p) => p.pid)).toEqual([10, 11]);
    expect(groups[0]?.shown.map((p) => p.pid)).toEqual([10, 11]);
    expect(groups[0]?.matchedInside).toBe(false);
  });

  it("makes a one-process group for a lone process", () => {
    const [group] = groupLiveProcesses([xcode], "");
    expect(group?.members).toEqual([xcode]);
    expect(group?.quit).toEqual([xcode]);
  });

  it("quits the members Rust marked", () => {
    const groups = groupLiveProcesses(rows, "");
    expect(groups[0]?.quit.map((p) => p.pid)).toEqual([10]);
    expect(groups[1]?.quit.map((p) => p.pid)).toEqual([20, 2214]);
  });

  it("sums figures, null only when every member is null", () => {
    const [chromeGroup, nodeGroup] = groupLiveProcesses(rows, "");
    expect(chromeGroup?.figures.cpu_pct).toBe(8);
    expect(chromeGroup?.figures.mem_bytes).toBe(150);
    expect(chromeGroup?.figures.threads).toBe(30);
    expect(chromeGroup?.figures.energy).toBeNull();
    expect(nodeGroup?.figures.cpu_pct).toBe(1);
    expect(nodeGroup?.figures.mem_bytes).toBe(30);
  });

  it("unions ports, sorted and unique, null only when none were read", () => {
    const [chromeGroup, nodeGroup] = groupLiveProcesses(rows, "");
    expect(chromeGroup?.figures.ports).toEqual([9222]);
    expect(nodeGroup?.figures.ports).toEqual([3000, 5173]);
    const unread = groupLiveProcesses(
      [liveProcess({ pid: 1, app: "a" }), liveProcess({ pid: 2, app: "a" })],
      ""
    );
    expect(unread[0]?.figures.ports).toBeNull();
  });

  it("names the user when members share one, else none", () => {
    const [chromeGroup, nodeGroup] = groupLiveProcesses(rows, "");
    expect(chromeGroup?.figures.user).toBe("me");
    expect(nodeGroup?.figures.user).toBeNull();
  });

  it("keeps a whole group when the app name matches, case-insensitively", () => {
    const groups = groupLiveProcesses(rows, "chrome");
    expect(groups.map((g) => g.name)).toEqual(["Google Chrome"]);
    expect(groups[0]?.shown.map((p) => p.pid)).toEqual([10, 11]);
    expect(groups[0]?.matchedInside).toBe(false);
  });

  it("keeps only matching members when a process name matches", () => {
    const groups = groupLiveProcesses(rows, "renderer");
    expect(groups.map((g) => g.name)).toEqual(["Google Chrome"]);
    expect(groups[0]?.shown.map((p) => p.pid)).toEqual([11]);
    expect(groups[0]?.members.map((p) => p.pid)).toEqual([10, 11]);
    expect(groups[0]?.matchedInside).toBe(true);
    expect(groups[0]?.figures.cpu_pct).toBe(3);
  });

  it("matches a PID or port prefix inside a group", () => {
    const byPid = groupLiveProcesses(rows, "221");
    expect(byPid.map((g) => g.name)).toEqual(["node"]);
    expect(byPid[0]?.shown.map((p) => p.pid)).toEqual([2214]);
    expect(byPid[0]?.matchedInside).toBe(true);

    const byPort = groupLiveProcesses(rows, "517");
    expect(byPort[0]?.shown.map((p) => p.pid)).toEqual([20]);
  });

  it("drops groups with no match", () => {
    expect(groupLiveProcesses(rows, "nothing here")).toEqual([]);
  });
});

describe("runningByApp and its lookups", () => {
  const running = () => runningByApp(rows);

  it("maps each app to its running processes", () => {
    expect(
      running()
        .get("node")
        ?.map((p) => p.pid)
    ).toEqual([20, 2214]);
  });

  it("gives an app's quit targets by exact name", () => {
    expect(
      appQuitTargets(running(), "Google Chrome").map((p) => p.pid)
    ).toEqual([10]);
    expect(appQuitTargets(running(), "google chrome")).toEqual([]);
    expect(appQuitTargets(running(), "Safari")).toEqual([]);
    expect(appQuitTargets(null, "node")).toEqual([]);
  });
});

describe("diskTotal and netTotal", () => {
  it("add both directions and are null when either is", () => {
    expect(diskTotal({ disk_read_bps: 1, disk_write_bps: 2 })).toBe(3);
    expect(diskTotal({ disk_read_bps: null, disk_write_bps: 2 })).toBeNull();
    expect(netTotal({ net_rx_bps: 4, net_tx_bps: 5 })).toBe(9);
    expect(netTotal({ net_rx_bps: 4, net_tx_bps: null })).toBeNull();
  });
});
