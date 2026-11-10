import { render, screen } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import { AlertChip } from "./alert-chip";

describe("AlertChip", () => {
  it.each([
    { tone: "warn", icon: "lucide-triangle-alert", color: "text-warning" },
    {
      tone: "critical",
      icon: "lucide-octagon-alert",
      color: "text-destructive",
    },
  ] as const)(
    "shows the $tone text and decorative icon",
    ({ tone, icon, color }) => {
      render(<AlertChip tone={tone} text={`Pressure: ${tone}`} />);
      const chip = screen.getByText(`Pressure: ${tone}`);
      expect(chip).toBeVisible();
      expect(chip).toHaveClass(color);
      expect(chip.querySelector(`svg.${icon}`)).toHaveAttribute(
        "aria-hidden",
        "true"
      );
      expect(chip.querySelector("svg")).toHaveClass("icon-regular", "size-3");
      expectJsonRoundTrip(AlertChip, { tone, text: `Pressure: ${tone}` });
    }
  );
});

it("offers a small labeled chip", () => {
  const view = render(
    <AlertChip tone="warn" text="Pressure: warn" size="small" />
  );
  expect(screen.getByText("Pressure: warn")).toHaveClass("text-small");
  expect(view.container.querySelector("svg")).toHaveClass("size-3.5");
  expect(screen.getByText("Pressure: warn")).not.toHaveClass("shrink-0");
  expectJsonRoundTrip(AlertChip, {
    tone: "warn",
    text: "Pressure: warn",
    size: "small",
  });
});

it("offers a decorative icon-only variant", () => {
  const view = render(
    <AlertChip tone="critical" text="Connection failed" iconOnly />
  );
  expect(screen.queryByText("Connection failed")).not.toBeInTheDocument();
  expect(view.container.firstChild).toHaveAttribute("aria-hidden", "true");
  expect(view.container.querySelector("svg")).toHaveClass(
    "lucide-octagon-alert",
    "size-3"
  );
  expect(view.container.querySelector("svg")).not.toHaveClass("icon-regular");
  expectJsonRoundTrip(AlertChip, {
    tone: "critical",
    text: "Connection failed",
    iconOnly: true,
  });
});
