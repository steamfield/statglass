import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { expect, it } from "vitest";
import { ModulePage } from "./module-page";

it("heads the page with the window control and draws the cards for the chart window", async () => {
  renderWithProviders(
    <ModulePage title="CPU" subtitle="Apple M4 Pro">
      {(windowMs) => <p>Cards over {windowMs} ms</p>}
    </ModulePage>
  );
  expect(screen.getByRole("heading", { name: "CPU", level: 1 })).toBeVisible();
  expect(screen.getByText("Apple M4 Pro")).toBeVisible();
  expect(await screen.findByText(/^Cards over \d+ ms$/)).toBeVisible();
  expect(screen.getByRole("button", { name: /^Time range: / })).toBeVisible();
});

it("waits for settings before drawing any card", () => {
  renderWithProviders(
    <ModulePage title="GPU" actions={<span>Live</span>} header={<p>Machine</p>}>
      {() => <p>Cards</p>}
    </ModulePage>
  );
  expect(screen.getByRole("heading", { name: "GPU" })).toBeVisible();
  expect(screen.queryByText("Cards")).toBeNull();
  expect(screen.getByText("Live")).toBeVisible();
  expect(screen.getByText("Machine")).toBeVisible();
});
