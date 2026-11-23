import { createMockTransport } from "@core/mock-transport";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
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

  it("stays settled when a new reader mounts after a failed read", async () => {
    const transport = createMockTransport({ autoTick: false });
    let calls = 0;
    transport.getEdition = () => {
      calls++;
      return Promise.reject(new Error("bridge down"));
    };
    function Late() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <Probe />
          <button type="button" onClick={() => setShown(true)}>
            Mount
          </button>
          {shown && <Probe />}
        </>
      );
    }
    const { user } = renderWithProviders(<Late />, { transport });
    expect(await screen.findByText("false")).toBeVisible();
    const before = calls;
    await user.click(screen.getByRole("button", { name: "Mount" }));
    expect(screen.getAllByText("false")).toHaveLength(2);
    expect(screen.queryByText("waiting")).toBeNull();
    expect(calls).toBe(before);
  });
});
