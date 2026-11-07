import type { StoredProcess } from "@core/generated/bindings";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { CrosshairTooltip } from "./crosshair-tooltip";

const process = (name: string, cpu_pct: number | null): StoredProcess => ({
  name,
  pid: name.length,
  cpu_pct,
  mem_bytes: 0,
  threads: 1,
  idle_wakeups_per_s: null,
  energy: null,
});

function show(rows: StoredProcess[]) {
  renderWithProviders(
    <CrosshairTooltip
      title="Sun Oct 4 · 14:02:00"
      resolution="1 min avg"
      rows={[]}
      processes={{ ts_ms: 0, resolution: "snapshot", rows }}
      style={{}}
    />
  );
}

describe("CrosshairTooltip processes", () => {
  it("says nothing was stored when there are no process rows", async () => {
    show([]);
    expect(
      await screen.findByText("No processes stored near this time")
    ).toBeInTheDocument();
  });

  it("says CPU is missing when stored processes have no CPU reading", async () => {
    show([process("kernel_task", null), process("WindowServer", null)]);
    expect(
      await screen.findByText("No CPU readings for processes then")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No processes stored near this time")
    ).not.toBeInTheDocument();
  });

  it("lists processes by CPU, skipping those without a reading", async () => {
    show([process("kernel_task", null), process("WindowServer", 12)]);
    expect(await screen.findByText("WindowServer")).toBeInTheDocument();
    expect(screen.queryByText("kernel_task")).not.toBeInTheDocument();
  });
});
