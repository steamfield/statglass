import { PROCESSES } from "@core/mock/fixtures";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import ProcessDetailRoute from "./detail-route";
import ProcessesRoute from "./route";

const figma = PROCESSES.find((p) => p.name === "Figma");
if (!figma) throw new Error("no Figma fixture");
const detail = `/dashboard/processes/${figma.pid}/${figma.start_time_us}`;

const pages = (
  <Routes>
    <Route path="/dashboard/processes" element={<ProcessesRoute />} />
    <Route
      path="/dashboard/processes/:pid/:startTime"
      element={<ProcessDetailRoute />}
    />
  </Routes>
);

describe("Process detail back link", () => {
  it("returns to the Processes view it was opened from", async () => {
    const { user } = renderWithProviders(pages, {
      route: "/dashboard/processes?columns=memory",
    });
    await user.click(await screen.findByRole("link", { name: "Figma" }));
    const back = await screen.findByRole("link", {
      name: "Back to Processes",
    });
    expect(back).toHaveAttribute("href", "/dashboard/processes?columns=memory");
    await user.click(back);
    expect(
      await screen.findByRole("radio", { name: "Memory", checked: true })
    ).toBeVisible();
  });

  it.each([
    ["/dashboard/cpu", "Back to CPU", "/dashboard/cpu"],
    [
      "/dashboard/disk?from=1&to=2",
      "Back to Disk",
      "/dashboard/disk?from=1&to=2",
    ],
    ["/dashboard/power-sensors", "Back", "/dashboard/power-sensors"],
    ["https://example.com/", "Back to Disk", "/dashboard/disk"],
    [null, "Back to Disk", "/dashboard/disk"],
  ])("labels back=%s as %s", async (back, label, href) => {
    const query = back === null ? "" : `?back=${encodeURIComponent(back)}`;
    renderWithProviders(pages, { route: `${detail}${query}` });
    expect(await screen.findByRole("link", { name: label })).toHaveAttribute(
      "href",
      href
    );
  });
});
