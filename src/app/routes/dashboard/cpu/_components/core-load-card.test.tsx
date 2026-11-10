import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { CoreLoadCard } from "./core-load-card";

it("holds heatmap cells in an unhatched frame until backfill lands", async () => {
  vi.useFakeTimers();
  const r = renderWithProviders(
    <CoreLoadCard
      clusters={[{ letter: "P", cores: ["P0"] }]}
      windowMs={3_600_000}
    />,
    {
      transportOptions: { historyRows: 3600 },
      backfillMs: 3_600_000,
    }
  );
  try {
    await act(async () => {});
    expect(r.container.querySelector("[data-chart-loading]")).not.toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("data-loading", "true");
    // The widget's loading group suppresses the hatch on its empty cells.
    expect(r.container.querySelector("[data-gap]")).toHaveClass(
      "group-data-loading:bg-none"
    );
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("Loading chart history…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
    expect(screen.getByRole("img")).not.toHaveAttribute("data-loading");
    expect(r.container.querySelector(".h-2\\.5[style]")).not.toBeNull();
  } finally {
    r.unmount();
    r.transport.dispose();
    vi.useRealTimers();
  }
});
