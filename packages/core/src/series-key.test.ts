import { keyByLabel, parseLabels, seriesKeyString, sk } from "./series-key";

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

  it("does not split a value holding `,name=`", () => {
    const key = sk("disk.free", { vol: "/Volumes/a,b=c" });
    expect(key).toBe("disk.free{vol=/Volumes/a\\,b\\=c}");
    expect(parseLabels(key)).toEqual({ vol: "/Volumes/a,b=c" });
  });

  it("reads the escaped form Rust's Display writes", () => {
    // From `display_parse_round_trip` in crates/statglass-schema/src/series.rs.
    const rust = String.raw`thermal.zone{sensor=odd\,name\=x\{y\}\\z}`;
    expect(parseLabels(rust)).toEqual({ sensor: "odd,name=x{y}\\z" });
    expect(sk("thermal.zone", { sensor: "odd,name=x{y}\\z" })).toBe(rust);
  });
});

describe("seriesKeyString", () => {
  it.each([
    ["\\", "\\\\"],
    [",", "\\,"],
    ["=", "\\="],
    ["{", "\\{"],
    ["}", "\\}"],
  ])("escapes %s in names and values", (c, escaped) => {
    expect(seriesKeyString({ metric: "m", labels: [[`k${c}`, `v${c}`]] })).toBe(
      `m{k${escaped}=v${escaped}}`
    );
  });

  it("round-trips through parseLabels", () => {
    const labels = { a: "x\\,y", b: "}{", c: "=", d: "plain" };
    expect(parseLabels(sk("m", labels))).toEqual(labels);
  });
});

describe("keyByLabel", () => {
  it("builds the escaped key once per value", () => {
    const vol = keyByLabel("disk.free", "vol");
    const first = vol("/Volumes/a,b");
    expect(first).toBe(sk("disk.free", { vol: "/Volumes/a,b" }));
    expect(vol("/Volumes/a,b")).toBe(first);
    expect(vol("/")).toBe("disk.free{vol=/}");
  });
});
