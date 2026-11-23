import { PROCESSES } from "@core/mock/fixtures";
import { describe, expect, it } from "vitest";
import {
  COLUMN_SETS,
  columnSetOptions,
  countLine,
  hiddenNote,
} from "./processes";

describe("columnSetOptions", () => {
  it("offers Network only with per-process network (D-081)", () => {
    expect(
      columnSetOptions({
        network: true,
        gpu: false,
        energy: true,
        disk: true,
      }).map((o) => o.value)
    ).toEqual(["cpu", "memory", "energy", "disk", "network"]);
    expect(
      columnSetOptions({
        network: false,
        gpu: true,
        energy: true,
        disk: true,
      }).map((o) => o.value)
    ).not.toContain("network");
    expect(COLUMN_SETS.network.sort).toEqual({ by: "netTotal", dir: "desc" });
  });

  it("offers GPU only with per-process GPU time (D-085)", () => {
    expect(
      columnSetOptions({
        network: true,
        gpu: true,
        energy: true,
        disk: true,
      }).map((o) => o.value)
    ).toEqual(["cpu", "memory", "energy", "disk", "network", "gpu"]);
    expect(
      columnSetOptions({
        network: true,
        gpu: false,
        energy: true,
        disk: true,
      }).map((o) => o.value)
    ).not.toContain("gpu");
    expect(COLUMN_SETS.gpu.sort).toEqual({ by: "gpu", dir: "desc" });
  });
});

describe("countLine", () => {
  it("counts all processes and the threads of the shown ones", () => {
    const shown = PROCESSES.slice(0, 2);
    expect(countLine(PROCESSES, PROCESSES)).toMatch(
      /^8 processes · [\d,]+ threads$/
    );
    expect(countLine(PROCESSES, shown)).toBe("2 of 8 processes · 686 threads");
  });
});

describe("hiddenNote", () => {
  it("states the count when known and says it plainly when not", () => {
    expect(hiddenNote(335)).toMatch(/^335 processes hidden/);
    expect(hiddenNote(0)).toBe("");
    expect(hiddenNote(null)).toMatch(/hidden/);
  });
});
