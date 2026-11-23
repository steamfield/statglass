import type { LiveProcess } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { liveProcess } from "@tests/fixtures/processes";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler, useState } from "react";
import { describe, expect, it } from "vitest";
import type { ColumnSort } from "~/components/data-table";
import { useProcessRows } from "~/hooks/use-process-interest";
import { ProcessGroupTable } from "./process-group-table";
import { RemainderNote, RemainderRow } from "./remainder-row";
import type { GroupColumn, GroupRows, ProcessGroupTableProps } from "./types";

interface App {
  name: string;
  members: LiveProcess[];
  quit: LiveProcess[];
}

const proc = (pid: number, name: string, cpu: number | null, app = name) =>
  liveProcess({ pid, name, cpu_pct: cpu, app });

const sum = (app: App) => app.members.reduce((n, p) => n + (p.cpu_pct ?? 0), 0);

function apps(rows: LiveProcess[]): App[] {
  const byApp = new Map<string, LiveProcess[]>();
  for (const p of rows) byApp.set(p.app, [...(byApp.get(p.app) ?? []), p]);
  return [...byApp].map(([name, members]) => ({
    name,
    members,
    quit: members.slice(0, 1),
  }));
}

const groupRows = (
  groups: App[],
  over: Partial<GroupRows<App, LiveProcess>> = {}
): GroupRows<App, LiveProcess> => ({
  groups,
  key: (g) => `app:${g.name}`,
  name: (g) => g.name,
  count: (g) => g.members.length,
  members: (g) => g.members,
  targets: (g) => g.quit,
  memberKey: (p) => `${p.pid}:${p.start_time_us}`,
  memberName: (p) => p.name,
  memberPid: (p) => p.pid,
  memberTargets: (p) => [p],
  ...over,
});

const CPU: GroupColumn<App, LiveProcess> = {
  id: "cpu",
  header: "% CPU",
  align: "right",
  groupValue: sum,
  memberValue: (p) => p.cpu_pct,
  group: (g) => sum(g).toFixed(1),
  member: (p) => (p.cpu_pct === null ? "—" : p.cpu_pct.toFixed(1)),
};

const chrome = [
  proc(10, "Google Chrome", 5, "Google Chrome"),
  proc(11, "Chrome Helper", 30, "Google Chrome"),
  proc(12, "Chrome Helper (GPU)", 2, "Google Chrome"),
];
const ROWS = [...chrome, proc(20, "Xcode", 20), proc(30, "node", 1)];

function table(
  groups: App[],
  over: Partial<ProcessGroupTableProps<App, LiveProcess>> = {}
) {
  return (
    <ProcessGroupTable
      rows={groupRows(groups)}
      columns={[CPU]}
      nameHeader="Process"
      ariaLabel="Processes"
      selectable={false}
      empty="Nothing running"
      {...over}
    />
  );
}

/** Text of each body row's name cell, without the initial chip's letter. */
function names(label = "Processes"): string[] {
  const t = screen.getByRole("table", { name: label });
  return within(t)
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.getAttribute("data-name") ?? "")
    .filter(Boolean);
}

/** The body row whose name is `name`. */
function row(name: string): HTMLElement {
  const found = screen
    .getAllByRole("row")
    .find((r) => r.getAttribute("data-name") === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
}

function Sorted(
  props: Partial<ProcessGroupTableProps<App, LiveProcess>> & { groups: App[] }
) {
  const [sort, setSort] = useState<ColumnSort<string>>({
    by: "cpu",
    dir: "desc",
  });
  return table(props.groups, {
    sort: { value: sort, onChange: setSort, client: true },
    ...props,
  });
}

describe("ProcessGroupTable rows", () => {
  it("shows a group of several with its count, collapsed", () => {
    render(table(apps(ROWS)));
    expect(names()).toEqual(["Google Chrome", "Xcode", "node"]);
    expect(screen.getByText("3 processes")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show Google Chrome processes" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("cell", { name: "37.0" })).toBeVisible();
  });

  it("gives a group of one no chevron and no count", () => {
    render(table(apps(ROWS)));
    expect(
      screen.queryByRole("button", { name: "Show Xcode processes" })
    ).toBeNull();
    expect(screen.queryByText("1 process")).toBeNull();
  });

  it("expands with the chevron or ArrowRight and collapses with ArrowLeft", () => {
    render(table(apps(ROWS)));
    fireEvent.click(
      screen.getByRole("button", { name: "Show Google Chrome processes" })
    );
    expect(names()).toEqual([
      "Google Chrome",
      "Google Chrome",
      "Chrome Helper",
      "Chrome Helper (GPU)",
      "Xcode",
      "node",
    ]);
    const groupRow = screen
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-name") === "Google Chrome");
    if (!groupRow) throw new Error("no group row");
    fireEvent.keyDown(groupRow, { key: "ArrowLeft" });
    expect(names()).toEqual(["Google Chrome", "Xcode", "node"]);
    fireEvent.keyDown(groupRow, { key: "ArrowRight" });
    expect(names()).toHaveLength(6);
  });

  it("lists members of a forced-open group", () => {
    render(
      table(apps(ROWS), {
        rows: groupRows(apps(ROWS), {
          forcedOpen: (g) => g.name === "Google Chrome",
        }),
      })
    );
    expect(names()).toHaveLength(6);
  });

  it("gives a forced-open group no chevron, so a toggle cannot hide in it", () => {
    render(
      table(apps(ROWS), {
        rows: groupRows(apps(ROWS), {
          forcedOpen: (g) => g.name === "Google Chrome",
        }),
      })
    );
    expect(
      screen.queryByRole("button", { name: /Google Chrome processes/ })
    ).toBeNull();
    expect(screen.getByText("3 processes")).toBeVisible();
  });

  it("renders the empty row when there are no groups", () => {
    render(table([]));
    expect(screen.getByRole("cell", { name: "Nothing running" })).toBeVisible();
  });

  it("dims a member with no targets and offers it nothing", () => {
    renderWithProviders(
      table(apps(ROWS), {
        selectable: true,
        rows: groupRows(apps(ROWS), {
          forcedOpen: () => true,
          memberTargets: (p) => (p.pid === 12 ? [] : [p]),
        }),
      })
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Chrome Helper (GPU) (12)" })
    ).toBeDisabled();
  });
});

describe("ProcessGroupTable order", () => {
  it("sorts groups by their value and members by theirs, ties by pid", () => {
    const tied = [...ROWS, proc(13, "Chrome Helper", 2, "Google Chrome")];
    render(
      <Sorted
        groups={apps(tied)}
        rows={groupRows(apps(tied), { forcedOpen: () => true })}
      />
    );
    expect(names()).toEqual([
      "Google Chrome",
      "Chrome Helper",
      "Google Chrome",
      "Chrome Helper (GPU)",
      "Chrome Helper",
      "Xcode",
      "node",
    ]);
    const rows = screen.getAllByRole("row");
    const pids = rows
      .map((r) => r.getAttribute("data-pid"))
      .filter((p): p is string => p !== null);
    expect(pids.slice(2, 4)).toEqual(["12", "13"]);
  });

  it("sorts missing values last in both directions", async () => {
    const rows = [proc(1, "a", null), proc(2, "b", 3), proc(3, "c", 1)];
    const { user } = renderWithProviders(<Sorted groups={apps(rows)} />);
    expect(names()).toEqual(["b", "c", "a"]);
    await user.click(screen.getByRole("button", { name: /% CPU/ }));
    expect(names()).toEqual(["c", "b", "a"]);
  });

  it("sorts by name through the name header", async () => {
    const { user } = renderWithProviders(<Sorted groups={apps(ROWS)} />);
    await user.click(screen.getByRole("button", { name: /Process/ }));
    expect(names()).toEqual(["Google Chrome", "node", "Xcode"]);
  });

  it("keeps the order groups arrive in without a sort", () => {
    render(table(apps([proc(1, "low", 1), proc(2, "high", 99)])));
    expect(names()).toEqual(["low", "high"]);
  });

  it("holds group order while the pointer is over the table", () => {
    const { rerender } = render(
      <Sorted
        groups={apps([proc(1, "a", 50), proc(2, "b", 10)])}
        freezeOrderOnHover
        height={300}
      />
    );
    expect(names()).toEqual(["a", "b"]);
    const scroller = screen.getByTestId("process-table-scroll");
    fireEvent.pointerEnter(scroller);
    rerender(
      <Sorted
        groups={apps([proc(1, "a", 5), proc(2, "b", 90), proc(3, "c", 99)])}
        freezeOrderOnHover
        height={300}
      />
    );
    expect(names()).toEqual(["a", "b", "c"]);
    expect(screen.getByRole("cell", { name: "5.0" })).toBeInTheDocument();
    fireEvent.pointerLeave(scroller);
    expect(names()).toEqual(["c", "b", "a"]);
  });

  it("keeps members opened during a hold where they first appeared", () => {
    const frame = (helperA: number, helperB: number) =>
      apps([
        proc(1, "Safari", 1),
        proc(2, "Helper A", helperA, "Safari"),
        proc(3, "Helper B", helperB, "Safari"),
      ]);
    const { rerender } = render(
      <Sorted groups={frame(6, 2)} freezeOrderOnHover height={300} />
    );
    fireEvent.pointerEnter(screen.getByTestId("process-table-scroll"));
    fireEvent.click(
      screen.getByRole("button", { name: "Show Safari processes" })
    );
    expect(names()).toEqual(["Safari", "Helper A", "Helper B", "Safari"]);
    rerender(<Sorted groups={frame(6, 8)} freezeOrderOnHover height={300} />);
    expect(names()).toEqual(["Safari", "Helper A", "Helper B", "Safari"]);
  });

  it("re-sorts at once when a header is clicked while hovering", () => {
    render(
      <Sorted
        groups={apps([proc(1, "a", 50), proc(2, "b", 10)])}
        freezeOrderOnHover
        height={300}
      />
    );
    fireEvent.pointerEnter(screen.getByTestId("process-table-scroll"));
    fireEvent.click(screen.getByRole("button", { name: /% CPU/ }));
    expect(names()).toEqual(["b", "a"]);
  });
});

describe("ProcessGroupTable limit and trailing rows", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    proc(i + 1, `app${i + 1}`, 12 - i)
  );

  it("shows the first groups and toggles Show all", () => {
    render(table(apps(many), { limit: 10 }));
    expect(names()).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 apps" }));
    expect(names()).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show top 10" }));
    expect(names()).toHaveLength(10);
  });

  it("ignores the limit while searching", () => {
    render(table(apps(many), { limit: 10, searching: true }));
    expect(names()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("renders trailing rows across every column", () => {
    render(
      table(apps(ROWS), {
        after: ({ colSpan: span }) => (
          <tr>
            <td colSpan={span}>footnote {span}</td>
          </tr>
        ),
      })
    );
    expect(screen.getByRole("cell", { name: "footnote 2" })).toBeVisible();
  });
});

describe("ProcessGroupTable remainder rows", () => {
  it.each([true, false])(
    "lines a remainder row's cells up under the groups' (selectable %s)",
    (selectable) => {
      renderWithProviders(
        table(apps(ROWS), {
          selectable,
          after: (t) => (
            <>
              <RemainderRow
                table={t}
                columns={[CPU]}
                name="System and other"
                system
                first
                cell={(c) => `${c.id} 9.0`}
              />
              <RemainderNote table={t}>What the rest holds.</RemainderNote>
            </>
          ),
        })
      );
      const cellText = (r: HTMLElement) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent);
      const rest = screen.getByText("System and other").closest("tr");
      if (!rest) throw new Error("no remainder row");
      // Gutter, name, % CPU, actions: the group rows' cells, with nothing to select.
      const group = cellText(row("Xcode"));
      const cells = cellText(rest);
      expect(cells).toHaveLength(group.length);
      expect(cells.indexOf("cpu 9.0")).toBe(group.indexOf("20.0"));
      expect(cells.filter((c) => c === "")).toHaveLength(selectable ? 2 : 0);
      expect(within(rest).queryByRole("checkbox")).toBeNull();
      expect(
        screen.getByRole("cell", { name: "What the rest holds." })
      ).toHaveAttribute("colspan", String(group.length));
    }
  );
});

describe("ProcessGroupTable virtualization", () => {
  it("renders only the rows near the viewport", () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      proc(i + 1, `p${i + 1}`, 300 - i)
    );
    render(<Sorted groups={apps(rows)} height={300} />);
    expect(names().length).toBeLessThan(60);
  });
});

describe("ProcessGroupTable selection", () => {
  it("selects a group's targets from its checkbox", () => {
    renderWithProviders(table(apps(ROWS), { selectable: true }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Google Chrome" })
    );
    expect(screen.getByText(/1 selected/i)).toBeVisible();
  });

  it("selects one member from its checkbox", () => {
    renderWithProviders(
      table(apps(ROWS), {
        selectable: true,
        rows: groupRows(apps(ROWS), { forcedOpen: () => true }),
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Chrome Helper (11)" })
    );
    expect(screen.getByText(/1 selected/i)).toBeVisible();
  });

  it("selects every target with the header checkbox", () => {
    renderWithProviders(
      table(apps(ROWS), { selectable: true, allTargets: ROWS })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all matching processes" })
    );
    expect(screen.getByText(/5 selected/i)).toBeVisible();
  });

  it("disables a group row with no targets", () => {
    renderWithProviders(
      table(apps(ROWS), {
        selectable: true,
        rows: groupRows(apps(ROWS), {
          targets: (g) => (g.name === "Xcode" ? [] : g.quit),
        }),
      })
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Xcode (20)" })
    ).toBeDisabled();
  });

  it("explains a group or member that offers nothing where its actions would be", () => {
    renderWithProviders(
      table(apps(ROWS), {
        selectable: true,
        rows: groupRows(apps(ROWS), {
          forcedOpen: () => true,
          targets: (g) => (g.name === "Xcode" ? [] : g.quit),
          unavailable: () => "Not running",
          memberTargets: (p) => (p.pid === 12 ? [] : [p]),
          memberUnavailable: (p) => `Exited ${p.pid}`,
        }),
      })
    );
    const xcode = row("Xcode");
    const xcodeBox = within(xcode).getByRole("checkbox", {
      name: "Select Xcode (20)",
    });
    expect(xcodeBox).toBeDisabled();
    expect(xcodeBox).toHaveAccessibleDescription("Not running");
    expect(within(xcode).getAllByText("Not running")).toHaveLength(2);
    const helper = row("Chrome Helper (GPU)");
    const helperBox = within(helper).getByRole("checkbox", {
      name: "Select Chrome Helper (GPU) (12)",
    });
    expect(helperBox).toBeDisabled();
    expect(helperBox).toHaveAccessibleDescription("Exited 12");
    // Rows with targets keep their actions, not the reason.
    expect(screen.getAllByText("Not running")).toHaveLength(2);
    expect(screen.queryByText("Exited 11")).toBeNull();
  });

  it("has no checkbox column when not selectable", () => {
    render(table(apps(ROWS)));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("commits once per process frame while streaming", async () => {
    const transport = createMockTransport({ autoTick: false });
    let commits = 0;
    function Streaming() {
      const rows = useProcessRows() ?? ROWS;
      const [sort, setSort] = useState<ColumnSort<string>>({
        by: "cpu",
        dir: "desc",
      });
      return (
        <Profiler id="group-table" onRender={() => commits++}>
          {table(apps(rows), {
            selectable: true,
            height: 400,
            sort: { value: sort, onChange: setSort, client: true },
          })}
        </Profiler>
      );
    }
    const result = renderWithProviders(<Streaming />, { transport });
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    act(() => transport.push({ kind: "processes", ts_ms: 1000, rows: ROWS }));
    for (let tick = 1; tick <= 3; tick++) {
      const before = commits;
      act(() =>
        transport.push({
          kind: "processes",
          ts_ms: 1000 + tick * 1000,
          rows: ROWS.map((p) => ({ ...p, cpu_pct: tick * 100 + p.pid })),
        })
      );
      expect(
        screen.getByRole("cell", { name: `${(tick * 100 + 20).toFixed(1)}` })
      ).toBeVisible();
      expect(commits - before).toBe(1);
    }
    result.unmount();
    transport.dispose();
  });
});

describe("ProcessGroupTable contract options", () => {
  it("reports header clicks without reordering when the sort is not client-side", async () => {
    const changes: ColumnSort<string>[] = [];
    const { user } = renderWithProviders(
      table(apps([proc(1, "low", 1), proc(2, "high", 99)]), {
        sort: {
          value: { by: "cpu", dir: "desc" },
          onChange: (next) => changes.push(next),
          client: false,
        },
      })
    );
    expect(names()).toEqual(["low", "high"]);
    await user.click(screen.getByRole("button", { name: /% CPU/ }));
    expect(changes).toEqual([{ by: "cpu", dir: "asc" }]);
    expect(names()).toEqual(["low", "high"]);
  });

  it("breaks group ties by name under a client sort", () => {
    const rows = [proc(1, "zeta", 5), proc(2, "alpha", 5)];
    render(<Sorted groups={apps(rows)} />);
    expect(names()).toEqual(["alpha", "zeta"]);
  });

  it("links a member's name to its detail page", () => {
    renderWithProviders(
      table(apps(ROWS), {
        rows: groupRows(apps(ROWS), {
          forcedOpen: () => true,
          memberHref: (p) => `/dashboard/processes/${p.pid}/${p.start_time_us}`,
        }),
      })
    );
    expect(
      screen.getByRole("link", { name: /Chrome Helper \(GPU\)/ })
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/dashboard/processes/12/12")
    );
  });

  it("lets the page own expansion and add rows under an open group", () => {
    const seen: ReadonlySet<string>[] = [];
    function Owned() {
      const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
      return table(apps(ROWS), {
        expansion: {
          open,
          onChange: (next) => {
            seen.push(next);
            setOpen(next);
          },
        },
        afterMembers: (g, span) => (
          <tr>
            <td colSpan={span}>Load more {g.name}</td>
          </tr>
        ),
      });
    }
    render(<Owned />);
    expect(screen.queryByText(/Load more/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Show Google Chrome processes" })
    );
    expect([...(seen.at(-1) ?? [])]).toEqual(["app:Google Chrome"]);
    expect(screen.getByText("Load more Google Chrome")).toBeVisible();
    expect(names()).toHaveLength(6);
  });
});

describe("ProcessGroupTable expandability", () => {
  const recorded: App = { name: "Figma", members: [], quit: [] };

  it("expands a group whose count is unknown and lists what the page adds", () => {
    render(
      table([recorded, ...apps(ROWS)], {
        rows: groupRows([recorded, ...apps(ROWS)], {
          count: (g) => (g === recorded ? null : g.members.length),
          expandable: (g) => g === recorded || g.members.length > 1,
        }),
        afterMembers: (g, span) => (
          <tr>
            <td colSpan={span}>Load {g.name} processes</td>
          </tr>
        ),
      })
    );
    expect(row("Figma")).not.toHaveTextContent(/process/);
    fireEvent.click(
      screen.getByRole("button", { name: "Show Figma processes" })
    );
    expect(names()).toEqual(["Figma", "Google Chrome", "Xcode", "node"]);
    expect(screen.getByText("Load Figma processes")).toBeVisible();
  });

  it("keeps a group that may not expand closed even when forced open", () => {
    render(
      table(apps(ROWS), {
        rows: groupRows(apps(ROWS), {
          expandable: () => false,
          forcedOpen: () => true,
        }),
      })
    );
    expect(screen.queryByRole("button", { name: /processes/ })).toBeNull();
    expect(names()).toEqual(["Google Chrome", "Xcode", "node"]);
    expect(screen.getByText("3 processes")).toBeVisible();
  });
});

describe("ProcessGroupTable sortable headers", () => {
  const PORTS: GroupColumn<App, LiveProcess> = {
    id: "ports",
    header: "Ports",
    align: "left",
    sortable: true,
    group: () => "",
    member: () => "",
  };

  it("makes the name header plain text and a value-less column a sort button on a ranked table", async () => {
    const changes: ColumnSort<string>[] = [];
    const { user } = renderWithProviders(
      table(apps(ROWS), {
        columns: [CPU, PORTS],
        sort: {
          value: { by: "cpu", dir: "desc" },
          onChange: (next) => changes.push(next),
          client: false,
          nameSortable: false,
        },
      })
    );
    expect(
      screen.getByRole("columnheader", { name: "Process" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Process" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ports" }));
    expect(changes).toEqual([{ by: "ports", dir: "asc" }]);
  });

  it("leaves a column with no values and no `sortable` as plain text", () => {
    const { sortable: _, ...plain } = PORTS;
    renderWithProviders(
      table(apps(ROWS), {
        columns: [plain],
        sort: {
          value: { by: "cpu", dir: "desc" },
          onChange: () => undefined,
          client: false,
        },
      })
    );
    expect(screen.queryByRole("button", { name: "Ports" })).toBeNull();
    expect(screen.getByRole("button", { name: "Process" })).toBeVisible();
  });
});

describe("ProcessGroupTable group of one", () => {
  const docker = proc(40, "com.docker.backend", 1, "Docker");

  it("links and labels a group of one as its process", () => {
    renderWithProviders(
      table(apps([...ROWS, docker]), {
        selectable: true,
        rows: groupRows(apps([...ROWS, docker]), {
          memberHref: (p) => `/dashboard/processes/${p.pid}`,
        }),
      })
    );
    expect(screen.getByRole("link", { name: "Xcode" })).toHaveAttribute(
      "href",
      "/dashboard/processes/20"
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Xcode (20)" })
    ).toBeEnabled();
    expect(
      screen.getByRole("checkbox", { name: "Select Google Chrome" })
    ).toBeEnabled();
    // A group of several links nothing on its own row.
    expect(screen.queryByRole("link", { name: "Google Chrome" })).toBeNull();
  });

  it("shows the process name beside the app when they differ", () => {
    renderWithProviders(table(apps([...ROWS, docker]), { selectable: true }));
    const group = row("Docker");
    expect(within(group).getByText("com.docker.backend")).toBeVisible();
    expect(
      within(group).getByRole("checkbox", {
        name: "Select com.docker.backend (40)",
      })
    ).toBeVisible();
    expect(within(row("Xcode")).getAllByText(/Xcode/)).toHaveLength(1);
  });
});

describe("ProcessGroupTable before selection is known", () => {
  it("renders nothing while selectable is null", () => {
    renderWithProviders(table(apps(ROWS), { selectable: null }));
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("ProcessGroupTable ranked header", () => {
  it("names the ranked column's order without a button when it does not sort", () => {
    render(
      table(apps(ROWS), {
        columns: [{ ...CPU, sortable: false }],
        sort: {
          value: { by: "cpu", dir: "desc" },
          onChange: () => {},
          client: false,
          nameSortable: false,
        },
      })
    );
    const ranked = screen.getByRole("columnheader", { name: /% CPU/ });
    expect(ranked).toHaveAttribute("aria-sort", "descending");
    expect(ranked).toHaveTextContent("% CPU ↓");
    expect(within(ranked).queryByRole("button")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Process|% CPU/ })).toEqual(
      []
    );
  });
});
