import { render, screen } from "@testing-library/react";
import { ChartHistoryStatus } from "./chart-history-status";

it("keeps quiet loading text available to assistive technology", () => {
  render(<ChartHistoryStatus loading quiet />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading chart history…"
  );
  expect(screen.getByRole("status")).toHaveClass("sr-only");
});

it("keeps errors visible even when quiet and loading", () => {
  render(<ChartHistoryStatus loading error quiet />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Couldn't load chart history."
  );
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
});

it("keeps loading visible by default", () => {
  render(<ChartHistoryStatus loading />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading chart history…"
  );
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
});
