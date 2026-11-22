import type {
  DockerAvailability,
  DockerRuntimeApp,
  DockerSnapshot,
  DockerStatus,
} from "@core/generated/bindings";
import { mockDockerSnapshot } from "@core/mock/docker-fixtures";
import { engineStateView } from "./engine-state";

const NOW = 1_795_000_000_000;
const desktop: DockerRuntimeApp = {
  kind: "docker_desktop",
  name: "Docker Desktop",
  launchable: true,
};
const orbstack: DockerRuntimeApp = {
  kind: "orb_stack",
  name: "OrbStack",
  launchable: true,
};
const colima: DockerRuntimeApp = {
  kind: "colima",
  name: "Colima",
  launchable: false,
};

function snapshot(
  status: DockerStatus,
  availability: Partial<DockerAvailability> | null,
  patch: Partial<DockerSnapshot> = {}
): DockerSnapshot {
  const base = mockDockerSnapshot(0, NOW);
  return {
    ...base,
    status,
    engine: null,
    containers: [],
    availability:
      availability === null
        ? null
        : {
            reason: "not_running",
            runtimes: [],
            next_attempt_ms: NOW + 8_000,
            launching_until_ms: null,
            ...availability,
          },
    ...patch,
  };
}

describe("engineStateView", () => {
  it.each<DockerStatus>([
    "connected",
    "connecting",
    "paused",
    "idle_suspended",
    "disabled",
  ])("renders the page normally while %s", (status) => {
    expect(engineStateView(snapshot(status, null), NOW)).toBeNull();
  });

  it("offers to open the installed app when the engine isn't running", () => {
    const view = engineStateView(
      snapshot("unavailable", { reason: "not_running", runtimes: [desktop] }),
      NOW
    );
    expect(view).toMatchObject({
      tone: "warning",
      title: "Docker Desktop isn’t running",
      action: {
        kind: "launch",
        runtime: "docker_desktop",
        label: "Open Docker Desktop",
      },
      showRetry: true,
      nextAttemptMs: NOW + 8_000,
      launching: false,
    });
    expect(view?.summary).toContain("Start Docker Desktop");
  });

  it("prefers the first launchable runtime in Rust's order", () => {
    const view = engineStateView(
      snapshot("unavailable", {
        reason: "not_running",
        runtimes: [orbstack, colima],
      }),
      NOW
    );
    expect(view?.title).toBe("OrbStack isn’t running");
    expect(view?.action).toMatchObject({
      kind: "launch",
      runtime: "orb_stack",
    });
  });

  it("gives Colima a command to copy instead of a launch", () => {
    const view = engineStateView(
      snapshot("unavailable", { reason: "not_running", runtimes: [colima] }),
      NOW
    );
    expect(view?.title).toBe("Colima isn’t running");
    expect(view?.action).toEqual({
      kind: "copy",
      command: "colima start",
      label: "Copy command",
    });
  });

  it("says no engine was found when nothing is installed", () => {
    const view = engineStateView(
      snapshot("unavailable", { reason: "not_installed" }),
      NOW
    );
    expect(view).toMatchObject({
      tone: "info",
      title: "No Docker engine found",
      gifTheme: "not-found",
      action: { kind: "retry", label: "Retry" },
      showRetry: false,
    });
    expect(view?.summary).toContain("Docker Desktop, OrbStack, Colima");
  });

  it("names the engine that stopped and when it last reported", () => {
    const view = engineStateView(
      snapshot(
        "unavailable",
        { reason: "stopped", runtimes: [desktop] },
        { observed_ms: NOW - 60_000 }
      ),
      NOW
    );
    expect(view?.title).toBe("Docker Desktop stopped");
    expect(view?.lastReadingMs).toBe(NOW - 60_000);
    expect(view?.action).toMatchObject({ kind: "launch" });
  });

  it("asks the user to choose between several running engines", () => {
    const view = engineStateView(
      snapshot("unavailable", {
        reason: "choose_engine",
        runtimes: [desktop, orbstack],
      }),
      NOW
    );
    expect(view).toMatchObject({
      tone: "info",
      title: "Choose a Docker engine",
      action: { kind: "choose", label: "Choose engine…" },
    });
  });

  it("explains a selected engine that disappeared", () => {
    const view = engineStateView(
      snapshot(
        "unavailable",
        { reason: "selected_missing" },
        {
          settings: {
            enabled: true,
            selected_engine: "/Users/me/.colima/work/docker.sock",
            show_popover: false,
            show_tray_count: false,
          },
        }
      ),
      NOW
    );
    expect(view?.title).toBe("The selected engine is gone");
    expect(view?.summary).toContain("/Users/me/.colima/work/docker.sock");
    expect(view?.action).toMatchObject({ kind: "choose" });
  });

  it("shows a waiting state during the post-launch window", () => {
    const view = engineStateView(
      snapshot("unavailable", {
        reason: "not_running",
        runtimes: [desktop],
        launching_until_ms: NOW + 40_000,
      }),
      NOW
    );
    expect(view).toMatchObject({
      tone: "info",
      title: "Starting Docker Desktop…",
      action: null,
      launching: true,
    });
  });

  it("drops the waiting state once the launch window has passed", () => {
    const view = engineStateView(
      snapshot("unavailable", {
        reason: "not_running",
        runtimes: [desktop],
        launching_until_ms: NOW - 1,
      }),
      NOW
    );
    expect(view?.launching).toBe(false);
    expect(view?.title).toBe("Docker Desktop isn’t running");
  });

  it("treats socket permission and API version as blocking errors", () => {
    const denied = engineStateView(
      snapshot("permission_denied", null, {
        message: "Permission denied accessing the local Docker socket",
      }),
      NOW
    );
    expect(denied).toMatchObject({
      tone: "destructive",
      title: "StatGlass can’t open the Docker socket",
      action: { kind: "retry" },
      nextAttemptMs: null,
    });
    const old = engineStateView(snapshot("incompatible", null), NOW);
    expect(old).toMatchObject({
      tone: "destructive",
      title: "This Docker engine is too old",
    });
    expect(old?.summary).toContain("1.40");
  });

  it("falls back to a generic unreachable state without availability", () => {
    const view = engineStateView(snapshot("unavailable", null), NOW);
    expect(view).toMatchObject({
      tone: "warning",
      title: "Docker isn’t answering",
      action: { kind: "retry" },
    });
  });
});
