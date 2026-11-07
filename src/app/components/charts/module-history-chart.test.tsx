import { act, screen, waitFor } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { useModuleChart } from "~/hooks/use-module-chart";
import { ChartRangeProvider, useModuleRange } from "~/stores/chart-range";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { ModuleHistoryChart, type ModuleYAxis } from "./module-history-chart";

const KEYS = ["cpu.total"];

function Card({ yAxis }: { yAxis: ModuleYAxis }) {
  const range = useModuleRange();
  const chart = useModuleChart(KEYS, range?.windowMs ?? 60_000, "cpu", {
    brush: true,
  });
  return (
    <ModuleHistoryChart
      chart={chart}
      lines={[
        {
          key: "cpu.total",
          values: chart.series.values["cpu.total"] ?? [],
          step: 1,
        },
      ]}
      yAxis={yAxis}
      accent="cpu"
      height={160}
      subject="CPU"
      now={`now ${chart.series.values["cpu.total"]?.at(-1) ?? "none"}`}
    />
  );
}

const AXES: [string, ModuleYAxis][] = [
  ["percent", "percent"],
  ["auto ceiling", { ceiling: "auto", format: (v) => `${v}%` }],
];

describe.each(AXES)("ModuleHistoryChart, %s axis", (_name, yAxis) => {
  it("commits once per pushed frame", async () => {
    let store: HostStore | undefined;
    function Capture() {
      store = useHostStore();
      return null;
    }
    const commits: number[] = [];
    const { transport } = renderWithProviders(
      <ChartRangeProvider>
        <Capture />
        <Profiler
          id="chart"
          onRender={(_id, _phase, _actual, _base, _start, commit) =>
            commits.push(commit)
          }
        >
          <Card yAxis={yAxis} />
        </Profiler>
      </ChartRangeProvider>
    );
    await screen.findByRole("img", { name: /^CPU, last .*Drag to select/ });
    await waitFor(() => expect(store?.getState().layoutNo).not.toBeNull());
    await act(async () => {});
    const names: string[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const state = store?.getState();
      if (!state) throw new Error("Missing live store");
      commits.length = 0;
      await act(async () =>
        transport.push(nextFrame(state, { "cpu.total": 20 + tick * 30 }))
      );
      expect(commits).toHaveLength(1);
      names.push(
        screen
          .getByRole("img", { name: /^CPU, / })
          .getAttribute("aria-label") ?? ""
      );
    }
    // The figure moves every frame; the name holds it per 10 s bucket, so
    // three 1 s frames change it at most once.
    expect(new Set(names).size).toBeLessThanOrEqual(2);
  });
});

it("labels a fixed ceiling and its half through the format, with five x ticks", async () => {
  renderWithProviders(
    <ChartRangeProvider>
      <Card yAxis={{ ceiling: 16, format: (v) => `${v} GB`, gutter: 48 }} />
    </ChartRangeProvider>
  );
  await screen.findByRole("img", { name: /^CPU, last / });
  expect(screen.getByText("16 GB")).toBeInTheDocument();
  expect(screen.getByText("8 GB")).toBeInTheDocument();
  expect(screen.getByText("now")).toBeInTheDocument();
  expect(screen.getAllByText(/^−\d+m$/)).toHaveLength(4);
  expect(screen.getByText(/Drag across the chart/)).toHaveStyle({
    paddingLeft: "48px",
  });
});

it("snaps an auto ceiling on the binary ladder when the axis asks for it", async () => {
  // The mock's CPU fits a decimal 5 here; the binary ladder gives a power of two.
  renderWithProviders(
    <ChartRangeProvider>
      <Card
        yAxis={{
          ceiling: "auto",
          min: 1,
          ladder: "binary",
          format: (v) => `${v} u`,
        }}
      />
    </ChartRangeProvider>
  );
  await screen.findByRole("img", { name: /^CPU, last / });
  const ceiling = Number(
    (await screen.findAllByText(/^\d+(\.\d+)? u$/))[0]?.textContent?.split(
      " "
    )[0]
  );
  expect(Math.log2(ceiling) % 1).toBe(0);
});
