import { scenarioFlags } from "./fixtures";
import { MockGenerator } from "./generator";

it("rate extremes cycle through real zero, large rates and expired held readings", () => {
  const gen = new MockGenerator(scenarioFlags(["network-rate-extremes"]));
  const index = gen.indexOf("net.rx_total");
  expect(index).toBeGreaterThanOrEqual(0);
  const rows = Array.from({ length: 12 }, () => gen.next());
  expect(rows.slice(0, 4).map((row) => row.values[index])).toEqual([
    0, 0, 0, 0,
  ]);
  for (const row of rows.slice(4, 8))
    expect(row.values[index]).toBeGreaterThanOrEqual(999e9);
  expect(rows[8]?.values[index]).toBeNull();
  expect(rows[8]?.held[index]).toBeGreaterThan(0);
  expect(rows[10]?.held[index]).toBeNull();
  expect(gen.next().held[index]).toBe(0);
});
