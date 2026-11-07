import { parseLabels, seriesKeyString, sk } from "./series-key";

describe("parseLabels", () => {
  it("reads every label of a display key", () => {
    expect(parseLabels("cpu.load{core=P0}")).toEqual({ core: "P0" });
    expect(
      parseLabels(sk("cgroup.cpu", { name: "zulu", kind: "docker" }))
    ).toEqual({ kind: "docker", name: "zulu" });
  });

  it("is empty for a key without labels", () => {
    expect(parseLabels("disk.free{vol=/}").vol).toBe("/");
    expect(parseLabels("cpu.total").vol).toBeUndefined();
    expect(parseLabels("cpu.total")).toEqual({});
  });

  it("keeps `=`, `,` and braces inside a value", () => {
    const labels = { name: "PMU tdie1, die=2 {x}", vol: "/" };
    expect(
      parseLabels(
        seriesKeyString({
          metric: "m",
          labels: [
            ["name", labels.name],
            ["vol", "/"],
          ],
        })
      )
    ).toEqual(labels);
    expect(parseLabels(sk("power.sensor", { name: "a=b" }))).toEqual({
      name: "a=b",
    });
  });
});
