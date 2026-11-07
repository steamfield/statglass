import type { DiskIoPage } from "@core/generated/bindings";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler, useState } from "react";
import { BrushProvider } from "~/stores/brush-store";
import { DiskIoCharts, type IoSecondary, requestTime } from "./disk-io-charts";

describe("completed request time labels", () => {
  it("does not round a positive duration down to a real zero", () => {
    expect(requestTime(0.001, 12)).toBe("<0.01 ms");
    expect(requestTime(0, 12)).toBe("0 ms");
    expect(requestTime(0.095, 12)).toBe("0.1 ms");
  });
  it("distinguishes idle completion counts from unsupported counters", () => {
    expect(requestTime(null, 0)).toBe("— · No completed operations");
    expect(requestTime(null, null)).toBe("— · Unavailable");
    expect(requestTime(null, 12)).toBe("— · Unavailable");
  });
});

const MINUTE = 60_000;
// A fixed half hour, well in the past, on minute edges.
const FROM = Math.floor((Date.now() - 6 * 3_600_000) / MINUTE) * MINUTE;
const TO = FROM + 30 * MINUTE;
const PAGE: DiskIoPage = {
  from_ms: FROM,
  to_ms: TO,
  tier: "m1",
  bucket_ms: MINUTE,
  points: Array.from({ length: 30 }, (_, i) => ({
    t: FROM + i * MINUTE,
    read_bps: 100e6 + i * 1e6,
    write_bps: 20e6,
    read_ops_per_sec: 1800,
    write_ops_per_sec: 900,
    read_request_ms: 0.2,
    write_request_ms: 0.3,
  })),
  gaps: [],
  read_bytes: null,
  write_bytes: null,
  read_covered_ms: 0,
  write_covered_ms: 0,
};

function Charts({ onRender }: { onRender?: () => void }) {
  const [secondary, setSecondary] = useState<IoSecondary>("ops");
  const charts = (
    <DiskIoCharts
      page={PAGE}
      range={{ fromMs: FROM, toMs: TO }}
      fixedEndMs={TO}
      secondary={secondary}
      onSecondary={setSecondary}
    />
  );
  return (
    <BrushProvider>
      {onRender ? (
        <Profiler id="disk-io" onRender={onRender}>
          {charts}
        </Profiler>
      ) : (
        charts
      )}
    </BrushProvider>
  );
}

describe("DiskIoCharts", () => {
  it("fits the lower plot's ceiling to the series it switches to on a fixed range", async () => {
    const { user } = renderWithProviders(<Charts />);
    // Up to 1,800 ops/s reads on a 2,000 ceiling.
    expect(await screen.findByText("2,000 ops/s")).toBeVisible();
    await user.click(
      screen.getByRole("radio", { name: "Average request time" })
    );
    // Sub-millisecond requests sit on the 1 ms floor, not the held 2,000.
    expect(screen.getAllByText("1 ms")).toHaveLength(2);
    expect(screen.queryByText("2,000 ms")).toBeNull();
  });

  it("moves one crosshair and the tooltip across both plots without rendering", async () => {
    let commits = 0;
    const { container } = renderWithProviders(
      <Charts onRender={() => commits++} />
    );
    const brushes = await screen.findAllByRole("slider", {
      name: "Select a time range",
    });
    expect(brushes).toHaveLength(2);
    const [upper, lower] = brushes;
    if (!upper || !lower) throw new Error("Missing brush");
    for (const brush of brushes)
      brush.getBoundingClientRect = () => new DOMRect(0, 0, 600, 97);
    const lines = () => [
      ...container.querySelectorAll<HTMLElement>('[data-crosshair="paint"]'),
    ];
    const tip = () => container.querySelector<HTMLElement>('[role="tooltip"]');
    expect(lines()).toHaveLength(2);
    expect(tip()?.hidden).toBe(true);

    commits = 0;
    // Bucket 5 of 30 on the upper plot.
    fireEvent.pointerMove(upper, { clientX: 110, clientY: 10 });
    expect(lines().map((el) => el.hidden)).toEqual([false, false]);
    const [left] = new Set(lines().map((el) => el.style.left));
    expect(new Set(lines().map((el) => el.style.left)).size).toBe(1);
    expect(tip()?.hidden).toBe(false);
    const title = tip()?.textContent;
    expect(title).toContain("1,800 ops/s");

    // Bucket 20 on the lower plot moves the same crosshair and tooltip.
    fireEvent.pointerMove(lower, { clientX: 410, clientY: 60 });
    expect(new Set(lines().map((el) => el.style.left)).size).toBe(1);
    expect(lines()[0]?.style.left).not.toBe(left);
    expect(tip()?.textContent).not.toBe(title);

    fireEvent.pointerLeave(lower);
    expect(lines().every((el) => el.hidden)).toBe(true);
    expect(tip()?.hidden).toBe(true);
    expect(commits).toBe(0);
  });
});
