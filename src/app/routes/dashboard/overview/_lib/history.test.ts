import { scaleFrom } from "./history";

describe("scaleFrom", () => {
  it("never scales below the floor", () => {
    expect(scaleFrom(null, 5)).toBe(5);
    expect(scaleFrom(3, 5)).toBe(5);
    expect(scaleFrom(12, 5)).toBe(12);
  });
});
