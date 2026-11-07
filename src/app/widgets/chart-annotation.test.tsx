import { render } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import {
  annotationFraction,
  ChartAnnotation,
  type ChartAnnotationProps,
  ChartAnnotations,
} from "./chart-annotation";

const props: ChartAnnotationProps = {
  tsMs: 1_760_000_000_000,
  label: "ANE 1.4 W · Photos face analysis",
};

describe("ChartAnnotation", () => {
  it("renders the same after a JSON round trip", () => {
    expectJsonRoundTrip(ChartAnnotation, props);
    expectJsonRoundTrip(ChartAnnotation, { ...props, variant: "pill" });
  });

  it("shows its label", () => {
    const { getByText } = render(<ChartAnnotation {...props} />);
    expect(getByText(props.label)).toBeTruthy();
  });

  it("positions within a window and rejects moments outside it", () => {
    expect(annotationFraction(950, 1000, 100)).toBeCloseTo(0.5);
    expect(annotationFraction(1000, 1000, 100)).toBe(1);
    expect(annotationFraction(800, 1000, 100)).toBeNull();
    expect(annotationFraction(1100, 1000, 100)).toBeNull();
  });
});

describe("ChartAnnotations", () => {
  /** The layout's own width estimate, applied to the label as drawn. */
  const width = (text: string) => text.length * 6 + 16;
  const boxes = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>("div.absolute")].map((el) => {
      const text = el.textContent ?? "";
      const left = Number.parseFloat(el.style.left);
      return { text, top: el.style.top, left, right: left + width(text) };
    });

  it("leaves room for a merged label's +N so it does not overlap its neighbour", () => {
    const at = (s: number, label: string) => ({ tsMs: s * 1000, label });
    const { container } = render(
      <ChartAnnotations
        annotations={[
          at(10, "a".repeat(30)),
          at(11, "bbbb"),
          at(12, "cccc"),
          at(15.8, "dddd"),
        ]}
        tEndMs={100_000}
        windowMs={100_000}
        widthPx={1000}
      />
    );
    const placed = boxes(container);
    expect(placed.some((b) => b.text.includes(" +"))).toBe(true);
    for (const a of placed)
      for (const b of placed)
        if (a !== b && a.top === b.top && a.left < b.left)
          expect(a.right + 8).toBeLessThanOrEqual(b.left);
  });
});
