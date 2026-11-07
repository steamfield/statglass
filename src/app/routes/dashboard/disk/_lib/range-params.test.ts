import { describe, expect, it } from "vitest";
import { readRange, writeRange } from "./range-params";

describe("range params", () => {
  it("round-trips a range and leaves other params alone", () => {
    const params = new URLSearchParams("device=disk3&from=1&to=2");
    writeRange(params, { fromMs: 1_000, toMs: 61_000 });
    expect(params.toString()).toBe("device=disk3&from=1000&to=61000");
    expect(readRange(params)).toEqual({ fromMs: 1_000, toMs: 61_000 });
  });

  it("clears the range", () => {
    const params = new URLSearchParams("from=1000&to=61000&view=space");
    writeRange(params, null);
    expect(params.toString()).toBe("view=space");
    expect(readRange(params)).toBeNull();
  });

  it.each([
    "",
    "to=5",
    "from=5&to=5",
    "from=-1&to=5",
    "from=1.5&to=5",
    "from=a&to=5",
  ])("rejects %j", (query) => {
    expect(readRange(new URLSearchParams(query))).toBeNull();
  });
});
