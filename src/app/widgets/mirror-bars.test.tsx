import { render } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import styles from "~/lib/motion/motion.module.css";
import { MirrorBars, type MirrorBarsProps } from "./mirror-bars";

const props: MirrorBarsProps = {
  up: [2, 6, null, 12],
  down: [4, 26, null, 10],
  intervalMs: 1000,
  tEndMs: 1_760_000_000_000,
  accent: "net",
  ariaLabel: "Upload above the line, download below, last 4 seconds",
  upMax: 12,
  downMax: 26,
};

describe("MirrorBars", () => {
  it("keeps empty slots without gaps while loading, then settles both halves from the axis", () => {
    const { container, getByRole, rerender } = render(
      <MirrorBars {...props} upHeight={24} loading />
    );
    const root = getByRole("img");
    const bars = () => [...container.querySelectorAll<HTMLElement>(".flex-1")];
    expect(bars()).toHaveLength(8);
    expect(bars().map((b) => b.style.height)).toEqual(Array(8).fill("0px"));
    expect(container.querySelector("[data-gap]")).toBeNull();
    const data = root.querySelector<HTMLElement>("[data-bars]");
    expect(data).not.toHaveClass(styles.reveal ?? "");
    const track = container.querySelector("[data-chart-loading]");
    const axis = track?.parentElement;
    expect(axis).toHaveClass("h-px", "bg-axis");
    rerender(<MirrorBars {...props} upHeight={24} loading={false} />);
    expect(getByRole("img")).toBe(root);
    expect(root.querySelector("[data-bars]")).toBe(data);
    expect(data).toHaveClass(styles.reveal ?? "");
    expect(data?.style.getPropertyValue("--reveal-origin")).toBe("50% 24px");
    expect(container.querySelector("[data-chart-loading]")).toBeNull();
    expect(bars().map((b) => b.style.height)).toContain("24px");
    expect(bars().map((b) => b.style.height)).toContain("30px");
    expect(container.querySelectorAll("[data-gap]")).toHaveLength(2);
    // The axis is frame: it must not fade with the bars. The scrolled rows
    // carry the tick transform, so the settle is not on them either.
    expect(data).not.toContainElement(axis ?? null);
    for (const row of data?.querySelectorAll(":scope > .flex") ?? [])
      expect(row).not.toHaveClass(styles.reveal ?? "");
  });

  it("renders the same after a JSON round trip", () => {
    expectJsonRoundTrip(MirrorBars, props);
  });

  it("names the chart and its directions in the aria-label", () => {
    const { getByRole } = render(<MirrorBars {...props} />);
    expect(getByRole("img").getAttribute("aria-label")).toMatch(
      /Upload above.*download below/
    );
  });

  it("leaves a missing sample as an empty gap slot on both sides", () => {
    const { container } = render(<MirrorBars {...props} />);
    expect(container.querySelectorAll("[data-gap]")).toHaveLength(2);
  });

  it("scales each side to its own ceiling", () => {
    const { container } = render(<MirrorBars {...props} />);
    const heights = [...container.querySelectorAll("span")].map(
      (s) => (s as HTMLElement).style.height
    );
    expect(heights).toContain("18px"); // up max 12 fills the 18 px half
    expect(heights).toContain("30px"); // down max 26 fills the 30 px half
  });
});
