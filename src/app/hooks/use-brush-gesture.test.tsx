import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  type BrushGestureOptions,
  keyTarget,
  sliderValues,
  useBrushGesture,
} from "./use-brush-gesture";

const BOUNDS = { first: 0, last: 50, step: 10 };

describe("keyTarget", () => {
  it("steps the arrows by one bucket, snapped down to the step", () => {
    expect(keyTarget("ArrowRight", 20, BOUNDS)).toBe(30);
    expect(keyTarget("ArrowLeft", 20, BOUNDS)).toBe(10);
    expect(keyTarget("ArrowRight", 24, BOUNDS)).toBe(30);
  });

  it("goes to the ends on Home and End and never past them", () => {
    expect(keyTarget("Home", 20, BOUNDS)).toBe(0);
    expect(keyTarget("End", 20, BOUNDS)).toBe(50);
    expect(keyTarget("ArrowRight", 50, BOUNDS)).toBe(50);
    expect(keyTarget("ArrowLeft", 0, BOUNDS)).toBe(0);
  });

  it("ignores other keys", () => {
    expect(keyTarget("Tab", 20, BOUNDS)).toBeNull();
    expect(keyTarget("a", 20, BOUNDS)).toBeNull();
  });
});

describe("sliderValues", () => {
  it("counts positions in buckets from the first, not epoch ms", () => {
    expect(
      sliderValues(1_000_030, { first: 1_000_000, last: 1_000_050, step: 10 })
    ).toEqual({
      min: 0,
      max: 5,
      now: 3,
    });
  });
});

/** A plot 100 px wide over times 0 to 100, logging each callback. */
function Probe(props: Partial<BrushGestureOptions>) {
  const [log, setLog] = useState<string[]>([]);
  const [at, setAt] = useState(20);
  const add = (s: string) => setLog((l) => [...l, s]);
  const gesture = useBrushGesture({
    timeAt: (e) => e.clientX,
    onDrag: (a, t) => add(`drag ${a}-${t}`),
    onRelease: (a, t, dragged) =>
      add(`${dragged ? "drop" : "click"} ${a}-${t}`),
    onCancel: () => add("cancel"),
    keyBounds: () => BOUNDS,
    position: () => at,
    anchorFor: (a, dir) => (dir > 0 ? a : a + 10),
    onMove: (to) => {
      setAt(to);
      add(`move ${to}`);
    },
    onExtend: (a, to) => {
      setAt(to);
      add(`extend ${a}-${to}`);
    },
    onEnter: (a) => {
      add(`enter ${a}`);
      return a > 0;
    },
    onEscape: () => add("escape"),
    ...props,
  });
  return (
    <>
      <div
        role="slider"
        aria-valuenow={at}
        tabIndex={0}
        {...gesture.handlers}
      />
      <button type="button" onClick={gesture.reset}>
        Reset
      </button>
      <output>{log.join(", ")}</output>
    </>
  );
}

const plot = () => screen.getByRole("slider");
const log = () => screen.getByRole("status").textContent;

describe("useBrushGesture: pointer", () => {
  it("treats a press that moves less than the slop as a click", () => {
    render(<Probe />);
    fireEvent.pointerDown(plot(), { button: 0, clientX: 40 });
    fireEvent.pointerMove(plot(), { clientX: 42 });
    fireEvent.pointerUp(plot(), { clientX: 42 });
    expect(log()).toBe("click 40-42");
  });

  it("drags once past the slop, and stays a drag back inside it", () => {
    render(<Probe />);
    fireEvent.pointerDown(plot(), { button: 0, clientX: 40 });
    fireEvent.pointerMove(plot(), { clientX: 60 });
    fireEvent.pointerMove(plot(), { clientX: 41 });
    fireEvent.pointerUp(plot(), { clientX: 41 });
    expect(log()).toBe("drag 40-60, drag 40-41, drop 40-41");
  });

  it("ignores other buttons and presses the owner refuses", () => {
    const { rerender } = render(<Probe />);
    fireEvent.pointerDown(plot(), { button: 2, clientX: 40 });
    fireEvent.pointerUp(plot(), { clientX: 80 });
    rerender(<Probe canDrag={() => false} />);
    fireEvent.pointerDown(plot(), { button: 0, clientX: 40 });
    fireEvent.pointerUp(plot(), { clientX: 80 });
    expect(log()).toBe("");
  });

  it("cancels a drag that loses its pointer capture, but not a finished one", () => {
    render(<Probe />);
    fireEvent.pointerDown(plot(), { button: 0, clientX: 40 });
    fireEvent.lostPointerCapture(plot());
    fireEvent.pointerUp(plot(), { clientX: 80 });
    fireEvent.pointerDown(plot(), { button: 0, clientX: 40 });
    fireEvent.pointerUp(plot(), { clientX: 40 });
    fireEvent.lostPointerCapture(plot());
    expect(log()).toBe("cancel, click 40-40");
  });

  it("forgets a press on reset, so its release does nothing", () => {
    render(<Probe />);
    fireEvent.pointerDown(plot(), { button: 0, clientX: 40 });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.pointerUp(plot(), { clientX: 80 });
    expect(log()).toBe("");
  });
});

describe("useBrushGesture: keyboard", () => {
  it("moves on arrows and extends from the owner's anchor with Shift", () => {
    render(<Probe />);
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    fireEvent.keyDown(plot(), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(plot(), { key: "End", shiftKey: true });
    expect(log()).toBe("move 30, extend 40-20, extend 30-50");
  });

  it("prevents the default of a key it acts on, only", () => {
    render(<Probe />);
    expect(fireEvent.keyDown(plot(), { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(plot(), { key: "Tab" })).toBe(true);
  });

  it("hands Enter and Space the cursor, preventing default only when handled", () => {
    render(<Probe />);
    expect(fireEvent.keyDown(plot(), { key: "Enter" })).toBe(false);
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(fireEvent.keyDown(plot(), { key: " " })).toBe(true);
    expect(log()).toBe("enter 20, move 0, enter 0");
  });

  it("passes Escape to the owner", () => {
    render(<Probe />);
    fireEvent.keyDown(plot(), { key: "Escape" });
    expect(log()).toBe("escape");
  });

  it("holds moves the owner refuses, and makes Shift a plain move when it cannot extend", () => {
    const { rerender } = render(<Probe canMove={() => false} />);
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(log()).toBe("");
    rerender(<Probe canExtend={() => false} />);
    fireEvent.keyDown(plot(), { key: "ArrowRight", shiftKey: true });
    expect(log()).toBe("move 30");
  });
});
