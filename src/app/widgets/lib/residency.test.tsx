import { render, screen } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import { StackBar } from "../stack-bar";
import { residencyLabel, residencySegments } from "./residency";
import { RESIDENCY } from "./sample-props";

const ROWS = [
  { label: "4.51 GHz", pct: 4 },
  { label: "3.86 GHz", pct: 9 },
  { label: "3.20 GHz", pct: 18 },
  { label: "2.42 GHz", pct: 10 },
  { label: "idle", pct: 59 },
];

describe("residency as a StackBar", () => {
  it("round-trips its props through JSON", () => {
    expectJsonRoundTrip(StackBar, RESIDENCY);
  });

  it("names each state with its share", () => {
    render(
      <StackBar
        segments={residencySegments(ROWS)}
        ariaLabel={residencyLabel("P-cluster residency", ROWS)}
      />
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "P-cluster residency: 4.51 GHz 4%, 3.86 GHz 9%, 3.20 GHz 18%, 2.42 GHz 10%, idle 59%"
    );
  });

  it("steps busy states down the accent, highest first, and draws idle as the track", () => {
    expect(
      residencySegments(ROWS).map((s) => [s.label, s.step, s.color])
    ).toEqual([
      ["4.51 GHz", "none", "color-mix(in srgb, var(--a) 100%, transparent)"],
      ["3.86 GHz", "none", "color-mix(in srgb, var(--a) 77%, transparent)"],
      ["3.20 GHz", "none", "color-mix(in srgb, var(--a) 53%, transparent)"],
      ["2.42 GHz", "none", "color-mix(in srgb, var(--a) 30%, transparent)"],
      ["idle", "track", undefined],
    ]);
    render(<StackBar segments={residencySegments(ROWS)} />);
    const slices = screen.getByRole("img").querySelectorAll("span");
    expect(slices).toHaveLength(5);
    expect(slices[4]?.className).toContain("bg-track");
  });
});
