/**
 * The `@core/*` alias resolves under jest to the shared package's source.
 */

import { formatBytes } from "@core/format";
import { initialHostLive } from "@core/live-state";
import { expect, test } from "@jest/globals";

test("formats bytes through @core/format", () => {
  expect(formatBytes(17_600_000_000)).toBe("17.6 GB");
});

test("builds a host's initial live state through @core/live-state", () => {
  const live = initialHostLive("local");

  expect(live.hostId).toBe("local");
  expect(live.connection).toBe("connecting");
});
