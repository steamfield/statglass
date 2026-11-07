import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { HistoryRangeControl } from "./history-range-control";

const props = {
  picker: <button type="button">24h</button>,
  onPrevious: () => {},
  onNext: () => {},
  onLive: () => {},
};

it("offers next only away from live, and steps through the callbacks", async () => {
  const onPrevious = vi.fn();
  const onLive = vi.fn();
  const { rerender } = render(
    <HistoryRangeControl
      {...props}
      live
      onPrevious={onPrevious}
      onLive={onLive}
    />
  );
  expect(screen.queryByRole("button", { name: "Next range" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Previous range" }));
  expect(onPrevious).toHaveBeenCalledOnce();
  rerender(<HistoryRangeControl {...props} live={false} onLive={onLive} />);
  expect(screen.getByRole("button", { name: "Next range" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Live" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
});

it("holds the steps while pending and says it is busy, leaving the picker usable", () => {
  const { container } = render(
    <HistoryRangeControl {...props} live={false} pending />
  );
  for (const name of ["Previous range", "Next range", "Live"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(screen.getByRole("button", { name: "24h" })).toBeEnabled();
  expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
});

it("holds the steps when disabled without saying it is busy", () => {
  const { container } = render(
    <HistoryRangeControl {...props} live disabled />
  );
  expect(screen.getByRole("button", { name: "Live" })).toBeDisabled();
  expect(container.firstElementChild).not.toHaveAttribute("aria-busy");
});
