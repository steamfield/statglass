import { createMockTransport } from "@core/mock-transport";
import { waitFor } from "@testing-library/react";
import { HostClockContext } from "~/lib/host-clock";
import { renderWithProviders } from "../../../tests/test-utils";
import { useEvents } from "./use-events";

function Queries() {
  useEvents(60000, null);
  return null;
}

describe("remote history clock", () => {
  it.each([-120000, 120000])(
    "uses source time with %d ms skew for event windows",
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
      view.unmount();
      transport.dispose();
    }
  );
});
