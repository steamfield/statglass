import { mockContainer } from "@core/mock/docker";
import { describe, expect, it } from "vitest";
import {
  cpuLeader,
  dockerErrorMessage,
  filterContainers,
} from "./presentation";

describe("container view shaping", () => {
  it("searches official project, image and name without dropping exited rows", () => {
    const rows = Array.from({ length: 8 }, (_, i) => mockContainer(i, 1000));
    expect(filterContainers(rows, "PROJECT-2", "all").map((r) => r.id)).toEqual(
      ["container-5", "container-6", "container-7"]
    );
    expect(
      filterContainers(rows, "postgres", "exited").map((r) => r.id)
    ).toEqual(["container-6"]);
    expect(rows).toHaveLength(8);
  });
  it("keeps the monitored highest CPU leader, breaking ties by identity and ignoring gaps", () => {
    const a = mockContainer(1, 1000);
    const b = { ...mockContainer(2, 1000), metrics: { ...a.metrics } };
    const missing = {
      ...mockContainer(3, 1000),
      metrics: { ...a.metrics, cpu_pct: null },
    };
    expect(cpuLeader([missing, b, a])?.id).toBe(a.id);
    expect(cpuLeader([missing])).toBeUndefined();
    expect(cpuLeader([{ ...a, monitored: false }, b])?.id).toBe(b.id);
  });
});

describe("dockerErrorMessage", () => {
  it("keeps Rust's message, and words kinds without one by what they mean", () => {
    expect(
      dockerErrorMessage({ kind: "docker", message: "socket closed" })
    ).toBe("socket closed");
    expect(dockerErrorMessage({ kind: "history_unavailable" })).toBe(
      "History is unavailable. Live values still work."
    );
    expect(
      dockerErrorMessage({ kind: "store_too_new", found: 9, supported: 8 })
    ).toMatch(/newer version of StatGlass/);
    expect(dockerErrorMessage({ kind: "unknown_host", host: "h" })).toBe(
      "This host is no longer in your host list."
    );
    expect(dockerErrorMessage({ kind: "remote_host", host: "h" })).toBe(
      "This host does not share this data."
    );
    expect(dockerErrorMessage(new Error(""))).toBe(
      "Docker didn't answer. Try again."
    );
  });
});
