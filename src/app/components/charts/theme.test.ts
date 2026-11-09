import { withAlpha } from "~/components/charts/theme";

describe("withAlpha", () => {
  it("applies alpha to a hex token", () => {
    expect(withAlpha("#06b6d4", 0.2)).toBe("rgba(6, 182, 212, 0.2)");
  });

  it("multiplies alpha into a translucent rgba token", () => {
    expect(withAlpha("rgba(255, 255, 255, 0.5)", 0.5)).toBe(
      "rgba(255, 255, 255, 0.25)"
    );
    expect(withAlpha("rgb(9 9 11 / 40%)", 0.5)).toBe("rgba(9, 9, 11, 0.2)");
  });

  it("round-trips a hex token at full alpha", () => {
    expect(withAlpha("#06b6d4", 1)).toBe("rgba(6, 182, 212, 1)");
  });

  // happy-dom has no canvas, so these take the probe's no-canvas path. The
  // canvas path (oklch, color-mix, named colors) is only exercised in a browser.
  it("returns a string it cannot parse unchanged", () => {
    expect(withAlpha("", 0.5)).toBe("");
    expect(withAlpha("var(--x)", 0.5)).toBe("var(--x)");
  });
});
