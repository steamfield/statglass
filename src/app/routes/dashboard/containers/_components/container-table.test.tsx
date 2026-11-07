import type { DockerContainer } from "@core/generated/bindings";
import { mockContainer } from "@core/mock/docker";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { ContainerSort } from "../_lib/presentation";
import { ContainerTable } from "./container-table";

const defaults = {
  sort: { by: "cpu", dir: "desc" } as const,
  onSort: () => {},
  grouped: false,
  onCollapse: () => {},
};
const first = {
  ...mockContainer(0, 1000),
  name: "api",
  project: "liveoak",
  lifecycle: "running" as const,
  metrics: { ...mockContainer(0, 1000).metrics, cpu_pct: 200 },
};
const second = {
  ...mockContainer(1, 1000),
  name: "web",
  project: null,
  lifecycle: "running" as const,
  metrics: { ...mockContainer(1, 1000).metrics, cpu_pct: 100 },
};

it.each(["Image", "Ports"])(
  "starts right-aligned %s text ascending then flips",
  (label) => {
    function Harness() {
      const [sort, onSort] = useState<ContainerSort>(defaults.sort);
      return (
        <ContainerTable
          {...defaults}
          sort={sort}
          onSort={onSort}
          columns={["image", "ports"]}
          rows={[
            { ...first, image: "z-image", ports: ["9000"] },
            { ...second, image: "a-image", ports: ["1000"] },
          ]}
        />
      );
    }
    renderWithProviders(<Harness />);
    fireEvent.click(
      within(screen.getByRole("columnheader", { name: label })).getByRole(
        "button"
      )
    );
    expect(
      screen.getByRole("columnheader", { name: new RegExp(label) })
    ).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getAllByRole("link")[0]).toHaveTextContent("web");
    fireEvent.click(
      within(
        screen.getByRole("columnheader", { name: new RegExp(label) })
      ).getByRole("button")
    );
    expect(
      screen.getByRole("columnheader", { name: new RegExp(label) })
    ).toHaveAttribute("aria-sort", "descending");
    expect(screen.getAllByRole("link")[0]).toHaveTextContent("api");
  }
);

it("holds row order while focused, updates values, and resumes on blur without a status bar", () => {
  let update: (rows: DockerContainer[]) => void = () => {};
  function Harness() {
    const [rows, setRows] = useState<DockerContainer[]>([first, second]);
    update = setRows;
    return <ContainerTable {...defaults} rows={rows} />;
  }
  const result = renderWithProviders(<Harness />);
  const names = () =>
    within(screen.getByRole("table"))
      .getAllByRole("link")
      .map((node) => node.textContent);
  expect(names()[0]).toContain("api");
  act(() => screen.getByRole("link", { name: /api/ }).focus());
  act(() =>
    update([
      { ...first, metrics: { ...first.metrics, cpu_pct: 10 } },
      { ...second, metrics: { ...second.metrics, cpu_pct: 300 } },
    ])
  );
  expect(names()[0]).toContain("api");
  expect(screen.getByText("300%")).toBeVisible();
  expect(screen.queryByText("Order paused")).toBeNull();
  fireEvent.blur(screen.getByRole("link", { name: /api/ }), {
    relatedTarget: document.body,
  });
  expect(names()[0]).toBe("web");
  result.unmount();
  result.transport.dispose();
});

it("stops holding after a mouse click focuses a row and the pointer leaves", () => {
  let update: (rows: DockerContainer[]) => void = () => {};
  function Harness() {
    const [rows, setRows] = useState<DockerContainer[]>([first, second]);
    update = setRows;
    return <ContainerTable {...defaults} rows={rows} />;
  }
  const result = renderWithProviders(<Harness />);
  const table = screen.getByRole("table");
  const scroller = table.parentElement;
  if (!scroller) throw new Error("Expected table scroller");
  fireEvent.pointerEnter(scroller);
  // A pointer focus: the browser draws no ring, so `:focus-visible` misses.
  const link = screen.getByRole("link", { name: /api/ });
  const matches = link.matches.bind(link);
  vi.spyOn(link, "matches").mockImplementation(
    (selector) => selector !== ":focus-visible" && matches(selector)
  );
  act(() => link.focus());
  fireEvent.pointerLeave(scroller);
  act(() =>
    update([
      { ...first, metrics: { ...first.metrics, cpu_pct: 10 } },
      { ...second, metrics: { ...second.metrics, cpu_pct: 300 } },
    ])
  );
  expect(within(table).getAllByRole("link")[0]).toHaveTextContent("web");
  result.unmount();
  result.transport.dispose();
});

it("resumes live sorting after a header context click and pointer leave", () => {
  let update: (rows: DockerContainer[]) => void = () => {};
  function Harness() {
    const [rows, setRows] = useState<DockerContainer[]>([first, second]);
    update = setRows;
    return <ContainerTable {...defaults} rows={rows} />;
  }
  const result = renderWithProviders(<Harness />);
  const table = screen.getByRole("table");
  const scroller = table.parentElement;
  if (!scroller) throw new Error("Expected table scroller");
  fireEvent.pointerEnter(scroller);
  fireEvent.contextMenu(
    within(table).getByRole("columnheader", { name: /Name/ })
  );
  act(() =>
    update([
      { ...first, metrics: { ...first.metrics, cpu_pct: 10 } },
      { ...second, metrics: { ...second.metrics, cpu_pct: 300 } },
    ])
  );
  fireEvent.pointerLeave(scroller);
  expect(within(table).getAllByRole("link")[0]).toHaveTextContent("web");
  result.unmount();
  result.transport.dispose();
});

it("separates chart swatches from recording and reports null stopped metrics", () => {
  const result = renderWithProviders(
    <ContainerTable
      {...defaults}
      rows={[
        {
          ...first,
          lifecycle: "exited",
          metrics: { ...first.metrics, cpu_pct: 500 },
        },
      ]}
      slots={{ [first.id]: 2 }}
    />
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText("1 matching containers")).toBeVisible();
  expect(screen.queryByText("500%")).toBeNull();
  expect(screen.queryByText("No explicit limit")).toBeNull();
  expect(screen.queryByText("No check")).toBeNull();
  expect(
    within(screen.getByRole("table")).getAllByText("—").length
  ).toBeGreaterThanOrEqual(3);
  result.unmount();
  result.transport.dispose();
});

it("draws the memory limit track after its own figure, with the limit muted", () => {
  const result = renderWithProviders(
    <ContainerTable
      {...defaults}
      rows={[
        {
          ...first,
          explicit_limit_bytes: 1_000_000_000,
          metrics: { ...first.metrics, working_set_bytes: 500_000_000 },
        },
        { ...second, explicit_limit_bytes: null },
      ]}
    />
  );
  const [limited, unlimited] = within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td:nth-child(5)"));
  const limit = within(limited as HTMLElement).getByText(/^\s*\/ /);
  expect(limit).toHaveClass("text-muted-foreground");
  const track = limited?.querySelector(
    "[aria-hidden][data-missing], [aria-hidden].bg-track"
  );
  expect(track).not.toBeNull();
  // The track follows the figure, and every live row keeps the same slot.
  expect(
    limit.compareDocumentPosition(track as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  for (const cell of [limited, unlimited])
    expect(cell?.querySelector(".w-12")).toHaveClass(
      "[@container(max-width:480px)]:hidden"
    );
  result.unmount();
  result.transport.dispose();
});

it("shows every unpaged row below the virtualization threshold and links row hover to its chart", () => {
  const focus = vi.fn();
  const rows = Array.from({ length: 40 }, (_, i) => ({
    ...mockContainer(i, 1000),
    name: `container ${i}`,
  }));
  const result = renderWithProviders(
    <ContainerTable
      {...defaults}
      rows={rows}
      slots={{ [rows[0]?.id ?? ""]: 1 }}
      onFocus={focus}
    />
  );
  expect(screen.getAllByRole("link")).toHaveLength(40);
  expect(screen.queryByRole("button", { name: "Next rows" })).toBeNull();
  const row = screen.getByRole("link", { name: /container 0/ }).closest("tr");
  if (row) fireEvent.pointerEnter(row);
  expect(focus).toHaveBeenCalledWith(rows[0]?.id);
  result.unmount();
  result.transport.dispose();
});

it("historical mode keeps removed identities and labels metric peaks", () => {
  const result = renderWithProviders(
    <ContainerTable
      {...defaults}
      rows={[{ ...first, lifecycle: "removed" }]}
      historical
      title="Containers · 11:20–11:21"
    />
  );
  expect(screen.getByRole("columnheader", { name: /Peak CPU/ })).toBeVisible();
  expect(
    screen.getByRole("columnheader", { name: /Peak memory/ })
  ).toBeVisible();
  expect(screen.getByText("200%")).toBeVisible();
  expect(screen.queryByRole("columnheader", { name: "Net" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Start|Stop/ })).toBeNull();
  result.unmount();
  result.transport.dispose();
});

it("groups a virtualized table, collapses and restores members, and scrolls to a focused member", () => {
  // Alpha sorts first: 60 busy containers, then 60 idle beta ones.
  const rows = Array.from({ length: 120 }, (_, i) => ({
    ...mockContainer(i, 1000),
    name: `container ${i}`,
    project: i < 60 ? "alpha" : "beta",
    lifecycle: "running" as const,
    metrics: { ...mockContainer(i, 1000).metrics, cpu_pct: 200 - i },
  }));
  let view: (collapsed: string[], focused?: string) => void = () => {};
  function Harness() {
    const [state, setState] = useState<{
      collapsed: string[];
      focused?: string;
    }>({ collapsed: [] });
    view = (collapsed, focused) =>
      setState(focused === undefined ? { collapsed } : { collapsed, focused });
    return (
      <ContainerTable
        {...defaults}
        rows={rows}
        grouped
        collapsed={state.collapsed}
        focused={state.focused ?? null}
      />
    );
  }
  const result = renderWithProviders(<Harness />);
  const group = (name: string) =>
    screen.queryByRole("button", { name: new RegExp(`^. ${name}`) });
  expect(group("alpha")).toHaveAttribute("aria-expanded", "true");
  expect(group("alpha")).toHaveTextContent("60 containers");
  expect(screen.getByRole("row", { name: /^container 0 · / })).toBeVisible();
  // The beta group sits past the rendered window.
  expect(group("beta")).toBeNull();

  act(() => view(["alpha"]));
  expect(group("alpha")).toHaveAttribute("aria-expanded", "false");
  expect(group("alpha")).toHaveTextContent("60 containers");
  expect(screen.queryByRole("row", { name: /^container 0 · / })).toBeNull();
  expect(group("beta")).toHaveTextContent("60 containers");
  expect(screen.getByRole("row", { name: /^container 60 · / })).toBeVisible();

  act(() => view([]));
  expect(screen.getByRole("row", { name: /^container 0 · / })).toBeVisible();
  expect(screen.queryByRole("row", { name: /^container 60 · / })).toBeNull();

  const scroller = screen.getByRole("table").parentElement;
  if (!scroller) throw new Error("Expected table scroller");
  // happy-dom has no layout, so give the scroller the estimated geometry.
  Object.defineProperty(scroller, "scrollHeight", { value: 122 * 44 });
  Object.defineProperty(scroller, "clientHeight", { value: 352 });
  const scrollTo = vi.spyOn(scroller, "scrollTo");
  act(() => view([], rows[110]?.id));
  // Container 110 is item 112, after both group rows: align "auto" brings
  // its bottom to the viewport's bottom edge.
  expect(scrollTo).toHaveBeenCalledWith(
    expect.objectContaining({ top: 113 * 44 - 352 })
  );
  result.unmount();
  result.transport.dispose();
});
