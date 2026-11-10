import { createMockTransport } from "@core/mock-transport";
import { waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useHostsRecentInterest } from "./use-hosts-recent-interest";

function Probe() {
  useHostsRecentInterest();
  return null;
}

it("holds recent interest for the route lifetime and releases it on unmount", async () => {
  const view = renderWithProviders(<Probe />);
  const { transport } = view;
  expect(
    transport.calls
      .filter((call) => call.command === "set_hosts_recent_interest")
      .map((call) => call.args[0])
  ).toEqual([true]);
  view.unmount();
  expect(
    transport.calls
      .filter((call) => call.command === "set_hosts_recent_interest")
      .map((call) => call.args[0])
  ).toEqual([true, false]);
  transport.dispose();
});

it("logs a rejected interest change with the requested state", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.setHostsRecentInterest = async () => {
    throw new Error("IPC closed");
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = renderWithProviders(<Probe />, { transport });
  try {
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "[hosts] setting recent history interest failed",
        { on: true, error: expect.any(Error) }
      )
    );
    view.unmount();
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "[hosts] setting recent history interest failed",
        { on: false, error: expect.any(Error) }
      )
    );
  } finally {
    view.unmount();
    transport.dispose();
    log.mockRestore();
  }
});
