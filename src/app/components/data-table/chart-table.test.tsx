import { formatPercent, MISSING } from "@core/format";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChartTable, type ChartTableRow } from "./chart-table";

/** Local time, so the labels read the same in any time zone. */
const at = (day: number, h: number, m: number, s = 0) =>
  new Date(2026, 9, day, h, m, s).getTime();
const pct = (v: number | null) => formatPercent(v);
const CPU = [{ id: "cpu", label: "CPU", format: pct }];
const stats = (min: number, avg: number, max: number) => ({ min, avg, max });

function bodyRows() {
  const [, body] = screen.getAllByRole("rowgroup");
  return within(body as HTMLElement)
    .getAllByRole("row")
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent)
    );
}

describe("ChartTable", () => {
  const rows: ChartTableRow[] = [
    { kind: "bucket", t: at(4, 9, 0, 20), values: [stats(5, 6, 7)] },
    { kind: "gap", t: at(4, 9, 0, 10), label: "Asleep 09:00–09:01" },
    { kind: "bucket", t: at(4, 9, 0, 0), values: [stats(1, 2, 30)] },
  ];
  const props = {
    label: "CPU values",
    series: CPU,
    rows,
    bucketMs: 10_000,
    fromMs: at(4, 9, 0),
    toMs: at(4, 9, 15),
    surface: "card" as const,
  };

  it("lists buckets oldest first with seconds for sub-minute buckets, and names each gap in place", () => {
    render(<ChartTable {...props} />);
    const table = screen.getByRole("table", { name: "CPU values" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    ).toEqual(["Time ↑", "Min", "Avg", "Max"]);
    expect(bodyRows()).toEqual([
      ["09:00:00", "1%", "2%", "30%"],
      ["09:00:10", "Asleep 09:00–09:01"],
      ["09:00:20", "5%", "6%", "7%"],
    ]);
  });

  it("sorts by a value column with gap rows last", async () => {
    render(<ChartTable {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(bodyRows().map((r) => r[0])).toEqual([
      "09:00:00",
      "09:00:20",
      "09:00:10",
    ]);
  });

  it("dates rows when the range spans days", () => {
    render(
      <ChartTable
        {...props}
        rows={[{ kind: "bucket", t: at(4, 23, 0), values: [stats(1, 1, 1)] }]}
        bucketMs={3_600_000}
        toMs={at(5, 1, 0)}
      />
    );
    expect(bodyRows()[0]?.[0]).toBe("Oct 4, 23:00");
  });

  it("groups min, avg and max under each series, with missing and partial readings", () => {
    render(
      <ChartTable
        {...props}
        series={[
          { id: "a", label: "api", format: pct },
          { id: "b", label: "worker", format: pct },
        ]}
        rows={[
          {
            kind: "bucket",
            t: at(4, 9, 0),
            values: [{ ...stats(1, 2, 3), partial: true }, null],
          },
        ]}
      />
    );
    const api = screen.getByRole("columnheader", { name: "api" });
    expect(api).toHaveAttribute("colspan", "3");
    expect(api).toHaveAttribute("scope", "colgroup");
    expect(bodyRows()).toEqual([
      ["09:00:00", "1%", "2%", "3% partial", MISSING, MISSING, MISSING],
    ]);
  });
});
