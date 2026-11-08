import { MISSING } from "@core/format";
import { batteryTime } from "./battery";

describe("battery time wording", () => {
  it("shows time to full while charging and remaining time on battery", () => {
    expect(batteryTime({ timeRemainingMin: 65 }, "charging")).toEqual({
      label: "To full",
      value: "1:05",
    });
    expect(batteryTime({ timeRemainingMin: 372 }, "battery")).toEqual({
      label: "Remaining",
      value: "6:12",
    });
  });
  it.each(["adapter", "charging"] as const)(
    "shows On power without an estimate on %s",
    (source) => {
      expect(batteryTime({ timeRemainingMin: null }, source)).toEqual({
        label: source === "charging" ? "To full" : "Remaining",
        value: "On power",
      });
    }
  );
  it.each(["battery", "unknown", null] as const)(
    "keeps missing estimates as gaps on %s",
    (source) => {
      expect(batteryTime({ timeRemainingMin: null }, source).value).toBe(
        MISSING
      );
    }
  );
  it("keeps a zero-minute estimate and the popover's adapter estimate", () => {
    expect(batteryTime({ timeRemainingMin: 0 }, "charging").value).toBe("0:00");
    expect(batteryTime({ timeRemainingMin: 65 }, "adapter").value).toBe("1:05");
  });
  it("preserves the Battery page's suppressed adapter time and missing countdowns", () => {
    expect(batteryTime({ timeRemainingMin: 65 }, "adapter", "page").value).toBe(
      MISSING
    );
    expect(
      batteryTime({ timeRemainingMin: null }, "charging", "page").value
    ).toBe(MISSING);
  });
});
