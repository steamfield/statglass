import { seriesKey } from "@core/series-key";
import { screen } from "@testing-library/react";
import { pushLayout } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { BatteryDayCard } from "./battery-day-card";

it("keeps fixed charge history idle on power-only frames and updates current battery readings", async () => {
  let store: HostStore | undefined;
  function Capture() {
    store = useHostStore();
    return null;
  }
  const commit = vi.fn();
  const r = renderWithProviders(
    <>
      <Capture />
      <Profiler id="battery-day" onRender={commit}>
        <BatteryDayCard />
      </Profiler>
    </>,
    {
      transportOptions: {
        now: () => 1_800_000_000_000,
        chartWindow: {
          absolute: { from_ms: 1_799_913_600_000, to_ms: 1_800_000_000_000 },
        },
      },
    }
  );
  await screen.findByRole("img", { name: /Battery charge/ });
  const state = store?.getState();
  if (!state) throw new Error("Missing host state");
  const keys = [
    "battery.charge",
    "battery.health",
    "battery.cycles",
    "battery.time_remaining",
    "battery.capacity_wh",
    "battery.design_wh",
    "power.system",
  ];
  const push = pushLayout(
    r.transport,
    99,
    keys.map((key) => seriesKey(key)),
    {
      kinds: keys.map((key) => (key === "power.system" ? "mean" : "gauge")),
      timeline: state.timeline ?? 0,
    }
  );
  let ts = state.lastTsMs ?? 1_800_000_000_000;
  const frame = (power: number, charge = 91) => {
    ts += 1000;
    push(ts, [charge, 97, 123, 90, 70, 75, power]);
  };
  frame(20);
  await screen.findByText("91%");
  const settled = commit.mock.calls.length;
  for (const power of [21, 22, 23]) frame(power);
  expect(commit).toHaveBeenCalledTimes(settled);
  frame(24, 90);
  expect(screen.getByText("90%")).toBeInTheDocument();
  expect(commit.mock.calls.length).toBeGreaterThan(settled);
  const chargeRead = r.transport.calls.find(
    (call) =>
      call.command === "query_history" &&
      JSON.stringify(call.args).includes("battery.charge")
  );
  expect(chargeRead?.args[0]).toMatchObject({
    from_ms: 1_799_913_600_000,
    to_ms: 1_800_000_000_000,
  });
  expect(
    r.transport.calls.some((call) => call.command === "battery_hours")
  ).toBe(false);
  expect(
    screen.queryByText("Charging", { exact: true })
  ).not.toBeInTheDocument();
});
