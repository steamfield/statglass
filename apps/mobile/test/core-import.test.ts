/**
 * The `@core/*` alias resolves under jest to the shared package's source,
 * including core modules that pull in their own ESM dependencies (d3).
 */
import { formatBytes } from "@core/format";
import { initialHostLive } from "@core/live-state";
import { layoutSpace, type SpaceEntry } from "@core/space-treemap";
import { expect, test } from "@jest/globals";

test("formats bytes through @core/format", () => {
  expect(formatBytes(17_600_000_000)).toBe("17.6 GB");
});

test("builds a host's initial live state through @core/live-state", () => {
  const live = initialHostLive("local");

  expect(live.hostId).toBe("local");
  expect(live.connection).toBe("connecting");
});

test("lays out a treemap through @core/space-treemap and d3-hierarchy", () => {
  const entry = (key: string, bytes: number): SpaceEntry => ({
    key,
    kind: "unmeasured",
    node: null,
    bytes,
    live: false,
  });

  const tiles = layoutSpace([entry("apps", 600), entry("logs", 400)], 200, 100);

  expect(tiles.map((tile) => [tile.key, tile.share])).toEqual([
    ["apps", 0.6],
    ["logs", 0.4],
  ]);
});
