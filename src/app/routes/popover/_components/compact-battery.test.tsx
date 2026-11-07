import { seriesKey } from "@core/series-key";
import { screen } from "@testing-library/react";
import { pushLayout } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { CompactPower } from "./compact-battery";

const T0 = 1_800_000_000_000;

/** The y of the oldest drawn point: it only moves when the ceiling does. */
function oldestY(): number {
  const d = screen
    .getByRole("img", { name: /System power/ })
    .querySelector("[data-line]")
    ?.getAttribute("d");
  const match = d?.match(/M\s*[-\d.e]+[ ,]([-\d.e]+)/);
  if (!match?.[1]) throw new Error(`no line in ${d}`);
  return Number(match[1]);
}

it("holds the power ceiling across ticks whose max stays within the nice step", async () => {
  const r = renderWithProviders(<CompactPower showBattery={false} />, {
    transportOptions: { now: () => T0 },
    backfillMs: 0,
  });
  await screen.findByRole("img", { name: /System power/ });
  const push = pushLayout(r.transport, 99, [seriesKey("power.system")], {
    kinds: ["mean"],
  });
  push(T0 + 1000, [11]);
  push(T0 + 2000, [11]);
  const first = oldestY();
  // 11 W snaps to a 20 W ceiling; 15 and 18 W stay under it.
  push(T0 + 3000, [15]);
  expect(oldestY()).toBeCloseTo(first);
  push(T0 + 4000, [18]);
  expect(oldestY()).toBeCloseTo(first);
});
