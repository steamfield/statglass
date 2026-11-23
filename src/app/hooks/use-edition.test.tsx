import { createMockTransport } from "@core/mock-transport";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { describe, expect, it } from "vitest";
import { useCanSignalSettled } from "./use-edition";

function Probe() {
  const settled = useCanSignalSettled();
  return <output>{settled === null ? "waiting" : String(settled)}</output>;
}

function mount(transport = createMockTransport({ autoTick: false })) {
  renderWithProviders(<Probe />, { transport });
}

describe("useCanSignalSettled", () => {
  it("waits for the edition, then says whether this Mac can quit", async () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("waiting");
    expect(await screen.findByText("true")).toBeVisible();
  });

  it("is false in the App Store edition", async () => {
    mount(createMockTransport({ autoTick: false, scenarios: ["appstore"] }));
    expect(await screen.findByText("false")).toBeVisible();
  });

  it("stops waiting when the edition cannot be read", async () => {
    const transport = createMockTransport({ autoTick: false });
    transport.getEdition = () => Promise.reject(new Error("bridge down"));
    mount(transport);
    expect(await screen.findByText("false")).toBeVisible();
  });
});
