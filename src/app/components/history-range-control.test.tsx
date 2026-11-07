import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

it("holds the steps while pending and says it is busy, leaving the picker usable", async () => {
  const onPrevious = vi.fn();
  const { container } = render(
    <HistoryRangeControl
      {...props}
      live={false}
      pending
      onPrevious={onPrevious}
    />
  );
  for (const name of ["Previous range", "Next range", "Live"])
    expect(screen.getByRole("button", { name })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  await userEvent.click(screen.getByRole("button", { name: "Previous range" }));
  expect(onPrevious).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "24h" })).toBeEnabled();
  expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
});

it("keeps focus on Previous across a pending step", async () => {
  const user = userEvent.setup();
  function Stepping() {
    const [pending, setPending] = useState(false);
    return (
      <>
        <HistoryRangeControl
          {...props}
          live={false}
          pending={pending}
          onPrevious={() => setPending(true)}
        />
        <button type="button" onClick={() => setPending(false)}>
          settle
        </button>
      </>
    );
  }
  render(<Stepping />);
  const previous = screen.getByRole("button", { name: "Previous range" });
  previous.focus();
  await user.keyboard("{Enter}");
  expect(previous).toHaveAttribute("aria-disabled", "true");
  // Browsers blur a natively disabled button; happy-dom doesn't, so check
  // the cause too.
  expect(previous).toBeEnabled();
  expect(previous).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(previous).toHaveFocus();
  act(() => screen.getByRole("button", { name: "settle" }).click());
  expect(previous).not.toHaveAttribute("aria-disabled");
  expect(previous).toHaveFocus();
});
