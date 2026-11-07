import { act, screen } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { useHostStore } from "./host-store";
import { useCpu, useMemory } from "./live-selectors";

const renders = { cpu: 0, memory: 0 };

function CpuCard() {
  renders.cpu++;
  const cpu = useCpu();
  return <p>cpu {cpu.total ?? "none"}</p>;
}

function MemoryCard() {
  renders.memory++;
  const mem = useMemory();
  return <p>mem {mem.pressure ?? "none"}</p>;
}

let storeRef: ReturnType<typeof useHostStore> | null = null;
function GrabStore() {
  storeRef = useHostStore();
  return null;
}

/**
 * The 1 Hz selector contract (frontend/testing.md): a frame that moves only
 * CPU values must not re-render a card that reads only Memory.
 */
describe("per-module selectors", () => {
  it("re-renders only the card whose slice changed", async () => {
    const { transport } = renderWithProviders(
      <>
        <GrabStore />
        <CpuCard />
        <MemoryCard />
      </>
    );
    await screen.findByText(/^cpu \d/);
    const state = () => {
      const s = storeRef?.getState();
      if (!s) throw new Error("no store");
      return s;
    };
    renders.cpu = 0;
    renders.memory = 0;
    act(() => transport.push(nextFrame(state(), { "cpu.total": 91 })));
    act(() => transport.push(nextFrame(state(), { "cpu.total": 92 })));

    expect(screen.getByText("cpu 92")).toBeInTheDocument();
    expect(renders.cpu).toBe(2);
    expect(renders.memory).toBe(0);
  });
});
