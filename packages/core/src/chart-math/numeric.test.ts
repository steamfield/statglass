import { scaleOrNull, sumOrNull } from "./numeric";

describe("sumOrNull", () => {
  it("adds the parts", () => {
    expect(sumOrNull(1.5, 2)).toBe(3.5);
    expect(sumOrNull(1, 2, 3)).toBe(6);
    expect(sumOrNull(0, 0)).toBe(0);
  });

  it("is null when any part is missing, never a partial total", () => {
    expect(sumOrNull(null, 2)).toBeNull();
    expect(sumOrNull(2, null)).toBeNull();
    expect(sumOrNull(1, 2, null)).toBeNull();
  });
});

describe("scaleOrNull", () => {
  it("scales a value and keeps a gap a gap", () => {
    expect(scaleOrNull(3, 8)).toBe(24);
    expect(scaleOrNull(0, 8)).toBe(0);
    expect(scaleOrNull(null, 8)).toBeNull();
  });
});
