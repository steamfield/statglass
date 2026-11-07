import { render } from "@testing-library/react";
import { MeterCell } from "./data-table-cells";

describe("MeterCell", () => {
  it("draws a fixed 48 px track and a fixed-width figure slot", () => {
    const { container } = render(
      <MeterCell fraction={0.25} fill="var(--color-cpu)">
        25.0%
      </MeterCell>
    );
    const [track, figure] = container.firstElementChild?.children ?? [];
    expect(track).toHaveClass("w-12");
    expect(figure).toHaveClass("w-11", "text-right", "figures");
    expect(figure).toHaveTextContent("25.0%");
  });

  it("widens the slot for a used / limit pair", () => {
    const { container } = render(
      <MeterCell fraction={0.5} fill="var(--color-mem)" figure="ratio">
        1 GB / 2 GB
      </MeterCell>
    );
    expect(container.firstElementChild?.children[1]).toHaveClass("min-w-30");
  });

  it("leaves the track empty for a missing reading, never a zero fill", () => {
    const { container } = render(
      <MeterCell fraction={null} fill="var(--color-cpu)">
        —
      </MeterCell>
    );
    const track = container.firstElementChild?.children[0];
    expect(track).toHaveAttribute("data-missing", "true");
    expect(track?.children).toHaveLength(0);
  });
});
