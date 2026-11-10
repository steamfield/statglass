import { act, cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "~/components/ui/tooltip";
import { HostCardRr } from "./host-card-rr";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("uses the source clock and ticks only once a minute", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const view = render(
    <TooltipProvider>
      <HostCardRr
        rr={{
          command: null,
          detail: "From client",
          startedMs: 1_000_000,
          clockOffsetMs: 179_000,
        }}
      />
    </TooltipProvider>
  );
  expect(screen.getByText("rr running")).toBeVisible();
  expect(screen.getByText("2 min")).toBeVisible();
  act(() => vi.advanceTimersByTime(59_999));
  expect(screen.getByText("2 min")).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("3 min")).toBeVisible();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("clamps a future start to less than a minute", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  render(
    <TooltipProvider>
      <HostCardRr
        rr={{
          command: "cargo test",
          detail: "From client",
          startedMs: 2_000_000,
          clockOffsetMs: 0,
        }}
      />
    </TooltipProvider>
  );
  expect(screen.getByText("<1 min")).toBeVisible();
  expect(screen.getByText("cargo test")).toBeVisible();
});
