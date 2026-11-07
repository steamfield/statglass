import { SPARK_SAMPLES, sparkPath } from "./tray-preview";

describe("sparkPath", () => {
  it("right-aligns the samples and starts a new segment after a gap", () => {
    expect(sparkPath([0, 100, null, 50])).toBe(
      "M25.5 14.0 L27.0 2.0 M29.9 8.0"
    );
  });

  it("keeps only the newest samples and draws nothing for an all-gap series", () => {
    const full = Array.from({ length: SPARK_SAMPLES + 5 }, (_, i) => i);
    expect(sparkPath(full).startsWith("M2.0 ")).toBe(true);
    expect(sparkPath([null, Number.NaN])).toBe("");
  });
});
