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
      ariaLabel={`CPU, ${chart.span}.`}
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
    for (let tick = 0; tick < 3; tick++) {
      const state = store?.getState();
      if (!state) throw new Error("Missing live store");
      commits.length = 0;
      await act(async () =>
        transport.push(nextFrame(state, { "cpu.total": 20 + tick * 30 }))
      );
      expect(commits).toHaveLength(1);
    }
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
