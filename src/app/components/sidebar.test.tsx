import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@tests/test-utils";
import { expect, it, vi } from "vitest";
import { Sidebar, type SidebarEntry, type SidebarProps } from "./sidebar";

const utilitiesSidebar: SidebarProps = {
  groups: [
    {
      id: "tools",
      entries: [
        {
          id: "settings",
          href: "/dashboard/settings",
          label: "Settings",
          icon: "settings",
        },
      ],
    },
    {
      id: "utilities",
      label: "Utilities",
      entries: [
        {
          id: "disk-space",
          href: "/dashboard/disk-space",
          label: "Disk space",
          icon: "disk-space",
          value: "75%",
          busy: { label: "Scan running" },
        },
      ],
    },
  ],
  active: "settings",
  status: { intervalMs: 1000, paused: false, onBattery: false },
  version: "test",
};

it("gives labeled groups a heading and a named list", () => {
  renderWithProviders(<Sidebar {...utilitiesSidebar} />);

  expect(
    screen.getByRole("heading", { level: 2, name: "Utilities" })
  ).toBeVisible();
  const utilities = screen.getByRole("list", { name: "Utilities" });
  expect(
    within(utilities).getByRole("link", { name: /^Disk space/ })
  ).toBeVisible();
});

it("leaves unlabeled groups without headings", () => {
  renderWithProviders(
    <Sidebar
      {...utilitiesSidebar}
      groups={utilitiesSidebar.groups.slice(0, 1)}
    />
  );

  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("list", { name: "" })).getByRole("link", {
      name: "Settings",
    })
  ).toBeVisible();
});

it("announces a busy entry and hides its value", () => {
  renderWithProviders(<Sidebar {...utilitiesSidebar} />);

  const link = screen.getByRole("link", {
    name: /^Disk space\s*, Scan running$/,
  });
  expect(link).toBeVisible();
  expect(within(link).queryByText("75%")).not.toBeInTheDocument();
});

it("moves focus to the last row of the last group with End", async () => {
  const { user } = renderWithProviders(<Sidebar {...utilitiesSidebar} />);

  screen.getByRole("link", { name: "Settings" }).focus();
  await user.keyboard("{End}");
  expect(screen.getByRole("link", { name: /^Disk space/ })).toHaveFocus();
});

it("keeps values, route selection, navigation handlers and keyboard order current when groups change", async () => {
  const user = userEvent.setup();
  const navigate = vi.fn();
  const nextNavigate = vi.fn();
  const nav: readonly SidebarEntry[] = [
    {
      id: "overview",
      href: "/dashboard/overview",
      label: "Overview",
      icon: "overview",
    },
  ];
  const tools: readonly SidebarEntry[] = [
    {
      id: "containers",
      href: "/dashboard/containers",
      label: "Containers",
      icon: "containers",
    },
  ];
  const props = (
    value: string,
    local: boolean,
    active: string,
    onNavigate: typeof navigate
  ) => ({
    groups: [
      { id: "nav", entries: nav },
      {
        id: "modules",
        entries: [
          {
            id: "cpu",
            href: "/dashboard/cpu",
            label: "CPU",
            icon: "cpu" as const,
            value,
          },
        ],
      },
      { id: "tools", entries: local ? tools : [] },
    ],
    active,
    onNavigate,
    status: { intervalMs: 1000, paused: false, onBattery: false },
    version: "test",
  });
  const view = render(
    <Sidebar {...props("10%", true, "overview", navigate)} />
  );
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await user.click(screen.getByRole("link", { name: "CPU 10%" }));
  expect(navigate).toHaveBeenLastCalledWith("/dashboard/cpu");

  view.rerender(<Sidebar {...props("10%", true, "cpu", navigate)} />);
  expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute(
    "aria-current"
  );
  expect(screen.getByRole("link", { name: "CPU 10%" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  view.rerender(<Sidebar {...props("20%", true, "cpu", navigate)} />);
  expect(screen.getByRole("link", { name: "CPU 20%" })).toBeVisible();
  view.rerender(<Sidebar {...props("20%", false, "cpu", navigate)} />);
  expect(screen.queryByRole("link", { name: "Containers" })).toBeNull();

  view.rerender(<Sidebar {...props("40%", false, "cpu", nextNavigate)} />);
  expect(screen.getByRole("link", { name: "CPU 40%" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute(
    "aria-current"
  );
  expect(screen.queryByRole("link", { name: "Containers" })).toBeNull();
  await user.click(screen.getByRole("link", { name: "Overview" }));
  expect(nextNavigate).toHaveBeenLastCalledWith("/dashboard/overview");
  await user.keyboard("{End}");
  expect(screen.getByRole("link", { name: "CPU 40%" })).toHaveFocus();

  view.rerender(<Sidebar {...props("60%", true, "cpu", nextNavigate)} />);
  await user.keyboard("{End}");
  expect(screen.getByRole("link", { name: "Containers" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(nextNavigate).toHaveBeenLastCalledWith("/dashboard/containers");
  await user.keyboard("{Home}{ArrowDown}");
  expect(screen.getByRole("link", { name: "CPU 60%" })).toHaveFocus();
  const latestNavigate = vi.fn();
  view.rerender(<Sidebar {...props("60%", true, "cpu", latestNavigate)} />);
  await user.click(screen.getByRole("link", { name: "Overview" }));
  expect(latestNavigate).toHaveBeenLastCalledWith("/dashboard/overview");
});

it("renders an optional footerAction without affecting active-pill navigation or arrow-key order", async () => {
  const user = userEvent.setup();
  const onFeedback = vi.fn();
  render(
    <Sidebar
      groups={[
        {
          id: "nav",
          entries: [
            {
              id: "overview",
              href: "/dashboard/overview",
              label: "Overview",
              icon: "overview",
            },
          ],
        },
        {
          id: "tools",
          entries: [
            {
              id: "settings",
              href: "/dashboard/settings",
              label: "Settings",
              icon: "settings",
            },
          ],
        },
      ]}
      active="overview"
      status={{ intervalMs: 1000, paused: false, onBattery: false }}
      version="test"
      footerAction={
        <button type="button" onClick={onFeedback}>
          Feedback
        </button>
      }
    />
  );

  const feedback = screen.getByRole("button", { name: "Feedback" });
  expect(feedback).toBeVisible();
  await user.click(feedback);
  expect(onFeedback).toHaveBeenCalledTimes(1);

  screen.getByRole("link", { name: "Overview" }).focus();
  await user.keyboard("{End}");
  expect(screen.getByRole("link", { name: "Settings" })).toHaveFocus();
});
