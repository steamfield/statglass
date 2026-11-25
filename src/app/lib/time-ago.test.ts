import { describe, expect, it } from "vitest";
import { agoLabel } from "./time-ago";

describe("agoLabel", () => {
  it("rounds an age down to minutes, hours or days", () => {
    expect(agoLabel(10 * 60_000, 6 * 60_000)).toBe("4 min ago");
    expect(agoLabel(3 * 3_600_000, 0)).toBe("3 h ago");
    expect(agoLabel(30_000, 0)).toBe("just now");
    expect(agoLabel(30 * 3_600_000, 0)).toBe("1 day ago");
    expect(agoLabel(80 * 3_600_000, 0)).toBe("3 days ago");
  });

  it("is empty when the time is unknown", () => {
    expect(agoLabel(10 * 60_000, null)).toBe("");
  });
});
