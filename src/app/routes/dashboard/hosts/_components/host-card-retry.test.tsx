import type { RemoteHostRecord } from "@core/generated/types";
import { mockHostVitals } from "@core/mock/remote-updates";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "~/components/ui/tooltip";
import { remoteHostCardModel } from "../_lib/host-card-model";
import { HostCardStatus } from "./host-card-status";

const NOW = 1_795_000_000_000;

function failing(
  status: Partial<RemoteHostRecord["status"]>
): RemoteHostRecord {
  return {
    config: {
      id: "studio",
      name: "Studio",
      lan: "studio.local",
      tailscale: null,
      enabled: true,
      mirror_budget_mb: 100,
    },
    os: "mac_os",
    status: {
      state: "connecting",
      route: null,
      last_seen_ms: NOW - 60_000,
      synced_through_ms: null,
      error: "studio.local: Operation timed out",
      failure_kind: "timeout",
      route_failures: [{ route: "lan", kind: "timeout" }],
      next_attempt_ms: null,
      attempt: 2,
      dialing: false,
      waiting_for_network: false,
      sync: "idle",
      clock_offset_ms: 0,
      agent_version: "0.12.1",
      agent_update: { kind: "up_to_date", installed: "0.12.1" },
      identity_changed: null,
      rr: null,
      vitals: mockHostVitals(false),
      update: null,
      last_update_failure: null,
      ...status,
    },
  };
}

function show(remote: RemoteHostRecord) {
  return render(
    <TooltipProvider>
      <HostCardStatus model={remoteHostCardModel(remote)} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("host card retry state", () => {
  it("maps the schedule into the card model only for a failing card", () => {
    const model = remoteHostCardModel(
      failing({ next_attempt_ms: NOW + 12_000 })
    );
    expect(model.retry).toEqual({
      nextAttemptMs: NOW + 12_000,
      dialing: false,
    });
    const live = failing({
      state: "connected",
      failure_kind: null,
      route_failures: [],
    });
    expect(remoteHostCardModel(live).retry).toBeNull();
    const off = failing({
      state: "disabled",
      failure_kind: null,
      route_failures: [],
    });
    expect(remoteHostCardModel(off).retry).toBeNull();
  });

  it("counts down to the next automatic attempt", () => {
    show(failing({ next_attempt_ms: NOW + 12_000 }));
    expect(screen.getByText("Retrying in 12 s")).toBeVisible();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("Retrying in 10 s")).toBeVisible();
  });

  it("says Retrying… once the countdown reaches zero", () => {
    show(failing({ next_attempt_ms: NOW + 1_000 }));
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.getByText("Retrying…")).toBeVisible();
  });

  it("shows Trying… while an attempt is in flight", () => {
    show(failing({ dialing: true }));
    expect(screen.getByText("Trying…")).toBeVisible();
    expect(screen.queryByText(/Retrying in/)).toBeNull();
  });

  it("shows no countdown while waiting for the network", () => {
    show(
      failing({
        failure_kind: "local_offline",
        route_failures: [{ route: "lan", kind: "local_offline" }],
        waiting_for_network: true,
      })
    );
    expect(screen.getByText("Waiting for network")).toBeVisible();
    expect(screen.queryByText(/Retrying/)).toBeNull();
  });
});
