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
