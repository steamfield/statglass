import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type RowHoldOptions, useRowHold } from "./use-row-hold";

function Probe(props: RowHoldOptions) {
  const { held, holdProps, release } = useRowHold(props);
  return (
    <div data-testid="surface" {...holdProps}>
      <button type="button">row</button>
      <button type="button" onClick={release}>
        release
      </button>
      <output>{held ? "held" : "free"}</output>
    </div>
  );
}
const state = () => screen.getByRole("status").textContent;

describe("useRowHold", () => {
  it("holds for the pointer, for focus inside and for the owner's reason", () => {
    const { rerender } = render(<Probe />);
    expect(state()).toBe("free");
    fireEvent.pointerEnter(screen.getByTestId("surface"));
    expect(state()).toBe("held");
    fireEvent.pointerLeave(screen.getByTestId("surface"));
    expect(state()).toBe("free");
    act(() => screen.getByRole("button", { name: "row" }).focus());
    expect(state()).toBe("held");
    act(() => screen.getByRole("button", { name: "row" }).blur());
    expect(state()).toBe("free");
    rerender(<Probe when />);
    expect(state()).toBe("held");
  });

  it("ignores the pointer when hover holding is off, and release clears it", () => {
    const { rerender } = render(<Probe pointer={false} />);
    fireEvent.pointerEnter(screen.getByTestId("surface"));
    expect(state()).toBe("free");
    rerender(<Probe />);
    expect(state()).toBe("held");
    fireEvent.click(screen.getByRole("button", { name: "release" }));
    expect(state()).toBe("free");
  });
});
