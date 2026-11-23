import { recordedProcessStart } from "@core/chart-range";
import type { LiveProcess } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { liveProcess } from "@tests/fixtures/processes";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler, useState } from "react";
import { RUNNING_APPS_VIEW } from "~/hooks/use-running-apps";
import {
  HistoricalUsageCard,
  type HistoricalUsageSort,
} from "./historical-usage-card";

const NOW = 1_800_000_000_000;
const RANGE = { fromMs: NOW - 600_000, toMs: NOW - 10_000 };
function setup(compare = false) {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const apps = vi.spyOn(transport, "queryHistoricalUsage");
  const processes = vi.spyOn(transport, "queryUsageProcesses");
  const rendered = renderWithProviders(
    <HistoricalUsageCard range={RANGE} by="cpu" compare={compare} />,
    { transport }
  );
  return { ...rendered, apps, processes };
}

it("ranks by the selected resource and reverses the same app set without another read", async () => {
  const { user, apps } = setup();
  const table = await screen.findByRole("table", {
    name: "Recorded apps in this range",
  });
  expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Compiler");
  await user.click(
    within(screen.getByRole("columnheader", { name: /Avg CPU/ })).getByRole(
      "button"
    )
  );
  expect(screen.getByRole("columnheader", { name: /Avg CPU/ })).toHaveAttribute(
    "aria-sort",
    "ascending"
  );
  expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Editor");
  expect(apps).toHaveBeenCalledTimes(1);
  expect(within(table).getAllByRole("row").at(-1)).toHaveTextContent(
    "reversing the order keeps those same apps"
  );
  await user.click(screen.getByRole("button", { name: "Peak RAM" }));
  await waitFor(() =>
    expect(apps).toHaveBeenLastCalledWith(
      expect.objectContaining({ by: "memory" })
    )
  );
  expect(
    screen.queryByRole("button", { name: /Quit|Terminate/ })
  ).not.toBeInTheDocument();
});

it("accepts external ranking and reports header sorting in controlled mode", async () => {
  const transport = createMockTransport({
    now: () => NOW,
    autoTick: false,
    chartWindow: { absolute: { from_ms: RANGE.fromMs, to_ms: RANGE.toMs } },
  });
  function Controlled() {
    const [sort, setSort] = useState<HistoricalUsageSort>({
      by: "cpu",
      dir: "desc",
    });
    return (
      <>
        <button
          type="button"
          onClick={() => setSort({ by: "cpu", dir: "desc" })}
        >
          Rank apps by CPU
        </button>
        <HistoricalUsageCard
          range={RANGE}
          by={sort.by}
          sort={sort}
          onSortChange={setSort}
        />
      </>
    );
  }
  const { user } = renderWithProviders(<Controlled />, {
    transport,
    route: "/dashboard/timeline",
  });
  await screen.findByText("Compiler");
  await user.click(
    within(screen.getByRole("columnheader", { name: "Peak RAM" })).getByRole(
      "button"
    )
  );
  await waitFor(() =>
    expect(
      screen.getByRole("columnheader", { name: /Peak RAM/ })
    ).toHaveAttribute("aria-sort", "descending")
  );
  await screen.findByText("Compiler");
  await user.click(
    within(screen.getByRole("columnheader", { name: /Peak RAM/ })).getByRole(
      "button"
    )
  );
  expect(
    screen.getByRole("columnheader", { name: /Peak RAM/ })
  ).toHaveAttribute("aria-sort", "ascending");
  expect(
    within(
      screen.getByRole("table", { name: "Recorded apps in this range" })
    ).getAllByRole("row")[1]
  ).toHaveTextContent("Editor");
  await user.click(screen.getByRole("button", { name: "Rank apps by CPU" }));
  await waitFor(() =>
    expect(
      screen.getByRole("columnheader", { name: /Avg CPU/ })
    ).toHaveAttribute("aria-sort", "descending")
  );
  await screen.findByText("Compiler");
});

it("resets local ranking when by changes and falls back when a sorted column disappears", async () => {
  function ChangingColumns() {
    const [by, setBy] = useState<"cpu" | "memory">("cpu");
    const [narrow, setNarrow] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setBy("memory")}>
          Memory default
        </button>
        <button type="button" onClick={() => setNarrow(true)}>
          CPU only
        </button>
        <HistoricalUsageCard
          range={RANGE}
          by={by}
          {...(narrow ? { columns: ["cpu"] } : {})}
        />
      </>
    );
  }
  const { user } = renderWithProviders(<ChangingColumns />, {
    transportOptions: { now: () => NOW },
  });
  await screen.findByText("Compiler");
  await user.click(
    within(screen.getByRole("columnheader", { name: /Avg CPU/ })).getByRole(
      "button"
    )
  );
  await user.click(screen.getByRole("button", { name: "Memory default" }));
  await waitFor(() =>
    expect(
      screen.getByRole("columnheader", { name: /Peak RAM/ })
    ).toHaveAttribute("aria-sort", "descending")
  );
  await screen.findByText("Compiler");
  await user.click(screen.getByRole("button", { name: "CPU only" }));
  await waitFor(() =>
    expect(
      screen.getByRole("columnheader", { name: /Avg CPU/ })
    ).toHaveAttribute("aria-sort", "descending")
  );
  expect(screen.queryByRole("columnheader", { name: /Peak RAM/ })).toBeNull();
});

it("compares the current membership against exactly the preceding equal interval", async () => {
  const { apps } = setup(true);
  await waitFor(() => expect(apps).toHaveBeenCalledTimes(2));
  expect(apps.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({
      from_ms: RANGE.fromMs - (RANGE.toMs - RANGE.fromMs),
      to_ms: RANGE.fromMs,
      app_names: ["Compiler", "Browser", "Editor"],
    })
  );
  await screen.findAllByText(/Previous .*pp/);
});

it("compares a new metric only once its own answer arrives, not the held one", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const original = transport.queryHistoricalUsage.bind(transport);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apps = vi
    .spyOn(transport, "queryHistoricalUsage")
    .mockImplementation(async (q) => {
      // Hold the new metric's own answer so the CPU answer stays on screen.
      if (q.by === "memory" && q.to_ms === RANGE.toMs) await gate;
      return original(q);
    });
  const { user } = renderWithProviders(
    <HistoricalUsageCard range={RANGE} by="cpu" compare />,
    { transport }
  );
  await waitFor(() => expect(apps).toHaveBeenCalledTimes(2));
  await user.click(await screen.findByRole("button", { name: "Peak RAM" }));
  await waitFor(() =>
    expect(apps.mock.calls.some(([q]) => q.by === "memory")).toBe(true)
  );
  const comparisons = () =>
    apps.mock.calls.filter(
      ([q]) => q.by === "memory" && q.to_ms === RANGE.fromMs
    );
  // While CPU's answer is held, nothing is compared against its app list.
  expect(comparisons()).toEqual([]);
  await act(async () => release());
  await waitFor(() => expect(comparisons()).toHaveLength(1));
});

it("keeps its rows and open app while a rolling window moves to the next answer", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const readApps = transport.queryHistoricalUsage.bind(transport);
  const readProcesses = transport.queryUsageProcesses.bind(transport);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const moved = (to: number) => to !== RANGE.toMs;
  vi.spyOn(transport, "queryHistoricalUsage").mockImplementation(async (q) => {
    if (moved(q.to_ms)) await gate;
    return readApps(q);
  });
  vi.spyOn(transport, "queryUsageProcesses").mockImplementation(async (q) => {
    if (moved(q.to_ms)) await gate;
    return readProcesses(q);
  });
  function Rolling() {
    const [step, setStep] = useState(0);
    const shift = step * 10_000;
    return (
      <>
        <button type="button" onClick={() => setStep((s) => s + 1)}>
          Advance
        </button>
        <HistoricalUsageCard
          range={{ fromMs: RANGE.fromMs + shift, toMs: RANGE.toMs + shift }}
          by="cpu"
          rolling
        />
      </>
    );
  }
  const { user } = renderWithProviders(<Rolling />, { transport });
  const table = await screen.findByRole("table", {
    name: "Recorded apps in this range",
  });
  await user.click(
    screen.getByRole("button", { name: "Show Compiler processes" })
  );
  await screen.findByText("4099");
  await user.click(screen.getByRole("button", { name: "Advance" }));
  // The next window is still loading: the same table, rows and open app.
  expect(
    screen.getByRole("table", { name: "Recorded apps in this range" })
  ).toBe(table);
  expect(screen.getByText("4099")).toBeVisible();
  expect(screen.queryByText(/Loading recorded|Refreshing recorded/)).toBeNull();
  await act(async () => release());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Hide Compiler processes" })
    ).toBeVisible()
  );
  expect(
    screen.getByRole("table", { name: "Recorded apps in this range" })
  ).toBe(table);
});

it("loads process instances lazily and refresh discards old continuation pages", async () => {
  const { user, processes } = setup();
  await screen.findByText("Compiler");
  expect(processes).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Show Compiler processes" })
  );
  await screen.findByText("4099");
  expect(screen.queryByText("4100")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Load more recorded processes" })
  );
  await screen.findByText("4124");
  expect(processes.mock.calls[1]?.[0].cursor).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(processes).toHaveBeenCalledTimes(3));
  expect(processes.mock.calls[2]?.[0].cursor).toBeNull();
  await screen.findByText("4099");
  expect(screen.queryByText("4124")).not.toBeInTheDocument();
});

it("keeps a fixed answer cached across live ticks and exposes partial resource coverage to keyboard users", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const read = transport.queryHistoricalUsage.bind(transport);
  const apps = vi
    .spyOn(transport, "queryHistoricalUsage")
    .mockImplementation(async (request) => {
      const result = await read(request);
      if (result.status === "ok")
        for (const app of result.data.apps) {
          const gpu = app.figures.coverage.find(
            (resource) => resource.metric === "gpu"
          );
          if (gpu)
            gpu.coverage = {
              supported: true,
              complete: false,
              measured_ms: 10_000,
              causes: ["read_failed"],
            };
        }
      return result;
    });
  const { user } = renderWithProviders(
    <HistoricalUsageCard range={RANGE} by="cpu" />,
    { transport }
  );
  const cell = await screen.findAllByRole("button", {
    name: /gpu:.*incomplete observation/,
  });
  expect(cell[0]).toHaveTextContent("partial");
  act(() => cell[0]?.focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "incomplete observation"
  );
  await user.keyboard("{Escape}");
  await act(() => transport.tick());
  expect(apps).toHaveBeenCalledTimes(1);
});

it("explains intervals beyond retained query support without truncating or querying", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const apps = vi.spyOn(transport, "queryHistoricalUsage");
  renderWithProviders(
    <HistoricalUsageCard
      range={{ fromMs: NOW - 90 * 86_400_000, toMs: NOW }}
      by="cpu"
    />,
    { transport }
  );
  await screen.findByText(/supports intervals up to 30 days/);
  expect(apps).not.toHaveBeenCalled();
});

it("retries a source error without offering to reset remote history", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const read = transport.queryHistoricalUsage.bind(transport);
  vi.spyOn(transport, "queryHistoricalUsage")
    .mockResolvedValueOnce({
      status: "error",
      error: { kind: "remote_unreachable", message: "disconnected" },
    })
    .mockImplementation(read);
  const { user } = renderWithProviders(
    <HistoricalUsageCard range={RANGE} by="cpu" />,
    { transport }
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: /reset/i })
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Compiler");
});

it("ignores a late answer after the selected interval changes", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const read = transport.queryHistoricalUsage.bind(transport);
  let release: (() => void) | undefined;
  vi.spyOn(transport, "queryHistoricalUsage").mockImplementation(
    async (request) => {
      const result = await read(request);
      if (request.to_ms === RANGE.toMs) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (result.status === "ok" && result.data.apps[0])
          result.data.apps[0].name = "Old selection";
      }
      return result;
    }
  );
  function Investigation() {
    const [range, setRange] = useState(RANGE);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            setRange({
              fromMs: RANGE.fromMs - 600_000,
              toMs: RANGE.toMs - 600_000,
            })
          }
        >
          Earlier selection
        </button>
        <HistoricalUsageCard range={range} by="cpu" />
      </>
    );
  }
  const { user } = renderWithProviders(<Investigation />, { transport });
  await waitFor(() => expect(release).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Earlier selection" }));
  await screen.findByText("Compiler");
  await act(async () => release?.());
  expect(screen.queryByText("Old selection")).not.toBeInTheDocument();
  expect(screen.getByText("Compiler")).toBeInTheDocument();
});

it("restarts a stale process continuation instead of retaining earlier pages", async () => {
  const { user, processes } = setup();
  await screen.findByText("Compiler");
  await user.click(
    screen.getByRole("button", { name: "Show Compiler processes" })
  );
  await screen.findByText("4099");
  processes.mockResolvedValueOnce({
    status: "error",
    error: {
      kind: "invalid_argument",
      message: "process history changed; restart expansion",
    },
  });
  await user.click(
    screen.getByRole("button", { name: "Load more recorded processes" })
  );
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Reload processes" }));
  await screen.findByText("4099");
  expect(processes.mock.calls.at(-1)?.[0].cursor).toBeNull();
  expect(screen.queryByText("4124")).not.toBeInTheDocument();
});

it("shows unrecorded history without inventing empty zero-valued app rows", async () => {
  const transport = createMockTransport({ now: () => NOW, autoTick: false });
  const apps = vi.spyOn(transport, "queryHistoricalUsage");
  renderWithProviders(
    <HistoricalUsageCard
      range={{
        fromMs: NOW - 40 * 86_400_000,
        toMs: NOW - 40 * 86_400_000 + 600_000,
      }}
      by="cpu"
      compare
    />,
    { transport }
  );
  await screen.findByText("Attribution was not recorded for this interval.");
  expect(
    screen.queryByRole("table", { name: "Recorded apps in this range" })
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Compiler")).not.toBeInTheDocument();
  expect(apps).toHaveBeenCalledTimes(1);
});

const compilerMain = liveProcess({
  pid: 9001,
  name: "Compiler",
  app: "Compiler",
  app_quit: true,
});
const compilerHelper = liveProcess({
  pid: 9002,
  name: "Compiler Helper",
  app: "Compiler",
  app_quit: false,
});

async function running(
  transport: ReturnType<typeof createMockTransport>,
  rows: LiveProcess[]
) {
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  act(() => transport.push({ kind: "processes", ts_ms: NOW, rows }));
}

describe("recorded rows act on what is running now", () => {
  it("asks for every running process while it can quit them", async () => {
    const { transport } = setup();
    await screen.findByText("Compiler");
    await waitFor(() =>
      expect(
        transport.calls
          .filter((c) => c.command === "set_process_interest")
          .map((c) => c.args[2])
      ).toContainEqual(RUNNING_APPS_VIEW)
    );
  });

  it("quits a running app's quit targets after the dialog; an app not running offers nothing", async () => {
    const { transport, user } = setup();
    await screen.findByText("Compiler");
    await running(transport, [compilerMain, compilerHelper]);
    const browser = await screen.findByRole("checkbox", {
      name: "Select Browser",
    });
    expect(browser).toBeDisabled();
    expect(browser).toHaveAccessibleDescription("Not running");
    await user.click(screen.getByRole("checkbox", { name: "Select Compiler" }));
    expect(screen.getByText("1 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Quit 1…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      transport.calls.filter((c) => c.command === "process_signal")
    ).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Quit" }));
    await waitFor(() =>
      expect(
        transport.calls
          .filter((c) => c.command === "process_signal")
          .map((c) => c.args.slice(1))
      ).toEqual([[9001, compilerMain.start_time_us, "quit"]])
    );
  });

  it("keeps the selection across a sort by another metric, and closes open apps", async () => {
    const { transport, user, apps } = setup();
    await screen.findByText("Compiler");
    await running(transport, [compilerMain, compilerHelper]);
    await user.click(
      await screen.findByRole("checkbox", { name: "Select Compiler" })
    );
    await user.click(
      screen.getByRole("button", { name: "Show Compiler processes" })
    );
    await user.click(
      within(screen.getByRole("columnheader", { name: "Peak RAM" })).getByRole(
        "button"
      )
    );
    await waitFor(() =>
      expect(apps).toHaveBeenLastCalledWith(
        expect.objectContaining({ by: "memory" })
      )
    );
    await waitFor(() =>
      expect(
        screen.getByRole("columnheader", { name: /Peak RAM/ })
      ).toHaveAttribute("aria-sort", "descending")
    );
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(
      await screen.findByRole("checkbox", { name: "Select Compiler" })
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Show Compiler processes" })
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("selects a recorded process only while that same process runs", async () => {
    const { transport, user, processes } = setup();
    await screen.findByText("Compiler");
    await user.click(
      screen.getByRole("button", { name: "Show Compiler processes" })
    );
    await screen.findByText(/4000/);
    const page = await processes.mock.results[0]?.value;
    const first = page?.status === "ok" ? page.data.processes[0] : undefined;
    if (!first) throw new Error("no recorded process");
    await running(transport, [
      compilerMain,
      liveProcess({
        pid: first.pid,
        start_time_us: first.start_time_us,
        name: "Compiler",
        app: "Compiler",
        app_quit: false,
      }),
    ]);
    expect(
      await screen.findByRole("checkbox", { name: "Select Compiler (4000)" })
    ).toBeEnabled();
    const exited = screen.getByRole("checkbox", {
      name: "Select Compiler (4001)",
    });
    expect(exited).toBeDisabled();
    expect(exited).toHaveAccessibleDescription("Not running");
  });

  /** A live process standing for a recorded one: same pid and start time. */
  const runningAs = (p: { pid: number; start_time_us: number }) =>
    liveProcess({
      pid: p.pid,
      start_time_us: p.start_time_us,
      name: "Compiler",
      app: "Compiler",
      app_quit: false,
    });

  it("adds processes from Load more to Command-A", async () => {
    const { transport, user, processes } = setup();
    await screen.findByText("Compiler");
    await user.click(
      screen.getByRole("button", { name: "Show Compiler processes" })
    );
    await screen.findByText("4099");
    const request = processes.mock.calls[0]?.[0];
    const first = await processes.mock.results[0]?.value;
    if (!request || first?.status !== "ok") throw new Error("no first page");
    // Read the next page ahead, so a process from it runs before it lists.
    const second = await transport.queryUsageProcesses({
      ...request,
      cursor: first.data.next_cursor,
    });
    const [listed] = first.data.processes;
    const later = second.status === "ok" ? second.data.processes[0] : null;
    if (!listed || !later) throw new Error("no recorded processes");
    await running(transport, [
      compilerMain,
      runningAs(listed),
      runningAs(later),
    ]);
    await user.click(screen.getByRole("checkbox", { name: "Select Compiler" }));
    await user.keyboard("{Meta>}a{/Meta}");
    // Compiler's quit target and the one listed process that runs.
    expect(screen.getByText("2 selected")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Load more recorded processes" })
    );
    await screen.findByText(String(later.pid));
    // Load more took focus; Command-A works from a row.
    act(() =>
      screen.getByRole("checkbox", { name: "Select Compiler" }).focus()
    );
    await user.keyboard("{Meta>}a{/Meta}");
    expect(screen.getByText("3 selected")).toBeVisible();
    // About 1 s locally; a loaded CI runner took it past the 5 s default.
  }, 15_000);

  it("says nothing is running only once the running processes are known", async () => {
    const { transport } = setup();
    // Hold back the batch the host sends as soon as the interest registers.
    vi.spyOn(transport, "setProcessInterest").mockReturnValue(
      new Promise(() => undefined)
    );
    const browser = await screen.findByRole("checkbox", {
      name: "Select Browser",
    });
    expect(browser).toBeDisabled();
    expect(screen.queryByText("Not running")).toBeNull();
    await running(transport, [compilerMain]);
    expect(
      screen.getByRole("checkbox", { name: "Select Browser" })
    ).toHaveAccessibleDescription("Not running");
  });

  it("names when each recorded process started, beside its pid", async () => {
    const { user, processes } = setup();
    await screen.findByText("Compiler");
    await user.click(
      screen.getByRole("button", { name: "Show Compiler processes" })
    );
    const pid = await screen.findByText("4000");
    const page = await processes.mock.results[0]?.value;
    const first = page?.status === "ok" ? page.data.processes[0] : undefined;
    if (!first) throw new Error("no recorded process");
    const started = `Started ${recordedProcessStart(first.start_time_us)}`;
    expect(pid).toHaveAttribute("title", started);
    expect(pid).toHaveTextContent(`4000, ${started}`);
  });

  it("shows recorded apps without selection when the edition cannot be read", async () => {
    const transport = createMockTransport({ now: () => NOW, autoTick: false });
    transport.getEdition = () => Promise.reject(new Error("edition offline"));
    renderWithProviders(<HistoricalUsageCard range={RANGE} by="cpu" />, {
      transport,
    });
    expect(await screen.findByText("Compiler")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("Loading recorded apps…")).toBeNull();
  });

  it("offers no selection where this build cannot quit", async () => {
    const transport = createMockTransport({
      now: () => NOW,
      autoTick: false,
      scenarios: ["appstore"],
    });
    renderWithProviders(<HistoricalUsageCard range={RANGE} by="cpu" />, {
      transport,
    });
    await screen.findByText("Compiler");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      transport.calls
        .filter((c) => c.command === "set_process_interest")
        .map((c) => c.args[2])
    ).not.toContainEqual(RUNNING_APPS_VIEW);
  });
});

describe("recorded rows on the live process stream", () => {
  it("does not re-render on a live tick that starts or ends no process", async () => {
    const transport = createMockTransport({ now: () => NOW, autoTick: false });
    let commits = 0;
    const { user } = renderWithProviders(
      <Profiler id="recorded" onRender={() => commits++}>
        <HistoricalUsageCard range={RANGE} by="cpu" />
      </Profiler>,
      { transport }
    );
    await screen.findByText("Compiler");
    await user.click(
      screen.getByRole("button", { name: "Show Compiler processes" })
    );
    await screen.findByText("4099");
    await running(transport, [compilerMain, compilerHelper]);
    await screen.findByRole("checkbox", { name: "Select Compiler" });
    for (let tick = 1; tick <= 3; tick++) {
      const before = commits;
      act(() =>
        transport.push({
          kind: "processes",
          ts_ms: NOW + tick * 1000,
          rows: [
            { ...compilerMain, cpu_pct: tick * 10 },
            { ...compilerHelper, cpu_pct: tick * 5 },
          ],
        })
      );
      expect(commits - before).toBe(0);
    }
  });

  it("does not re-render when a process outside the listed apps and processes starts or exits", async () => {
    const transport = createMockTransport({ now: () => NOW, autoTick: false });
    let commits = 0;
    const { user } = renderWithProviders(
      <Profiler id="recorded" onRender={() => commits++}>
        <HistoricalUsageCard range={RANGE} by="cpu" />
      </Profiler>,
      { transport }
    );
    await screen.findByText("Compiler");
    await user.click(
      screen.getByRole("button", { name: "Show Compiler processes" })
    );
    await screen.findByText("4099");
    await running(transport, [compilerMain, compilerHelper]);
    await screen.findByRole("checkbox", { name: "Select Compiler" });
    const terminal = liveProcess({
      pid: 7001,
      name: "Terminal",
      app: "Terminal",
    });
    const before = commits;
    for (const rows of [
      [compilerMain, compilerHelper, terminal],
      [compilerMain, compilerHelper],
    ]) {
      act(() => transport.push({ kind: "processes", ts_ms: NOW + 1000, rows }));
    }
    expect(commits - before).toBe(0);
    // A listed app's quit target exiting does change what its row offers.
    act(() =>
      transport.push({
        kind: "processes",
        ts_ms: NOW + 2000,
        rows: [compilerHelper, terminal],
      })
    );
    expect(commits).toBeGreaterThan(before);
  });
});
