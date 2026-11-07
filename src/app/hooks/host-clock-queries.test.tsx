import { createMockTransport } from "@core/mock-transport";
import { waitFor } from "@testing-library/react";
import { HostClockContext } from "~/lib/host-clock";
import { useMax24h } from "~/routes/dashboard/overview/_hooks/use-overview-history";
import { renderWithProviders } from "../../../tests/test-utils";
import { useEvents } from "./use-events";

function Queries() {
  useEvents(60000, null);
  useMax24h("cpu", "cpu.total");
  return null;
}

describe("remote history clock", () => {
  it.each([-120000, 120000])(
    "uses source time with %d ms skew for events and overview windows",
    async (skew) => {
      const sourceNow = Date.now() + skew;
      const transport = createMockTransport({ historyRows: 10 });
      const view = renderWithProviders(
        <HostClockContext.Provider value={() => sourceNow}>
          <Queries />
        </HostClockContext.Provider>,
        { transport }
      );
      await waitFor(() =>
        expect(
          transport.calls.some((call) => call.command === "query_events")
        ).toBe(true)
      );
      const events = transport.calls.find(
        (call) => call.command === "query_events"
      );
      expect(events?.args[1]).toBe(sourceNow - 60000);
      const stats = transport.calls.find(
        (call) => call.command === "query_series_stats"
      );
      expect(stats?.args.slice(2)).toEqual([sourceNow - 86400000, sourceNow]);
      view.unmount();
      transport.dispose();
    }
  );
});
