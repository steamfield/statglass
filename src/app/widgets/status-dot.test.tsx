import { render } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import { StatusDot } from "./status-dot";

describe("StatusDot", () => {
  it.each([
    { state: "live", classes: ["size-1.5", "bg-live"] },
    { state: "idle", classes: ["size-1.5", "bg-fg-faint"] },
    { state: "paused", classes: ["size-2.5", "icon-bold", "lucide-pause"] },
    {
      state: "stale",
      classes: ["size-1.5", "border", "border-muted-foreground"],
    },
  ] as const)("renders a decorative $state mark", ({ state, classes }) => {
    const { container } = render(
      <StatusDot state={state} className="shrink-0" />
    );
    const mark = container.firstElementChild;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveClass(...classes, "shrink-0");
    expect(mark).not.toHaveAttribute("tabindex");
    expectJsonRoundTrip(StatusDot, { state, className: "shrink-0" });
  });
});
