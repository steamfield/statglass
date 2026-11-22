import { createMockTransport } from "@core/mock-transport";
import { fireEvent, render, screen } from "@testing-library/react";
import { TransportProvider } from "~/lib/transport-context";
import { ErrorStateCard } from "./error-state-card";

function wrap(ui: React.ReactElement) {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const result = render(
    <TransportProvider transport={transport}>{ui}</TransportProvider>
  );
  return {
    ...result,
    dispose: () => {
      result.unmount();
      transport.dispose();
    },
  };
}

describe("ErrorStateCard", () => {
  it("renders title, summary, routes, collapsible details, and copies diagnostics", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const view = wrap(
      <ErrorStateCard
        variant="banner"
        tone="warning"
        title="Can’t connect to M4 Mini"
        meta="Saved history through 5:00 PM · Auto-retrying"
        summary="LAN (m4-mini.local) or Tailscale (m4-mini-ts) timed out."
        routes={[
          { kind: "lan", label: "LAN", alias: "m4-mini.local" },
          { kind: "tailscale", label: "Tailscale", alias: "m4-mini-ts" },
        ]}
        gifTheme="timeout"
        gifSeed="m4-mini:timeout"
        details={<p>Operation timed out</p>}
        copyText={"Host: M4 Mini\nError: Operation timed out"}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Can’t connect to M4 Mini" })
    ).toBeVisible();
    expect(screen.getByText("m4-mini-ts")).toBeVisible();
    const details = screen.getByText("Technical details").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Operation timed out")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(writeText).toHaveBeenCalledWith(
      "Host: M4 Mini\nError: Operation timed out"
    );
    view.dispose();
  });

  it("omits media container in compact popover mode", () => {
    const view = wrap(
      <ErrorStateCard
        variant="focal"
        compact
        tone="destructive"
        title="This view hit a snag"
        summary="StatGlass couldn’t display this view."
        gifTheme="server-error"
        gifSeed="popover"
      />
    );
    expect(
      view.container.querySelector('[data-part="gif"]')
    ).not.toBeInTheDocument();
    view.dispose();
  });
});
