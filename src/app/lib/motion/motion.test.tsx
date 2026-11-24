import { render, screen } from "@testing-library/react";
import { enter } from "./enter";
import { Swap } from "./swap";

describe("enter", () => {
  it("gives the item its stagger index and the variant's class", () => {
    const lift = enter(3);
    const fade = enter(3, "fade");
    expect(lift.style).toEqual({ "--i": 3 });
    expect(lift.className).not.toBe("");
    expect(fade.className).not.toBe(lift.className);
  });
});

describe("Swap", () => {
  it("remounts its content when the state changes, and only then", () => {
    const { rerender } = render(
      <Swap k="live">
        <b>1s</b>
      </Swap>
    );
    const first = screen.getByText("1s").parentElement;

    rerender(
      <Swap k="live">
        <b>2s</b>
      </Swap>
    );
    expect(screen.getByText("2s").parentElement).toBe(first);

    rerender(
      <Swap k="paused">
        <b>Paused</b>
      </Swap>
    );
    expect(screen.getByText("Paused").parentElement).not.toBe(first);
  });
});
