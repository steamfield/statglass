import { METRIC_CODES } from "@core/generated/bindings";
import { describe, expect, it } from "vitest";
import { thermalState } from "./thermal";

describe("thermalState", () => {
  it("decodes each published code", () => {
    for (const [state, code] of Object.entries(METRIC_CODES["thermal.state"])) {
      expect(thermalState(code)).toBe(state);
    }
  });

  it("treats a gap as no state", () => {
    expect(thermalState(null)).toBeNull();
    expect(thermalState(Number.NaN)).toBeNull();
  });
});
