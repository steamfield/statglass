import { expect, it } from "vitest";
import { commitsBack } from "./use-edge-swipe";

const width = 402;

it.each([
  ["past a third of the screen", { dx: 160, v: 0, sinceMoveMs: 0 }, true],
  ["short and slow", { dx: 60, v: 0.1, sinceMoveMs: 0 }, false],
  ["short but flicked", { dx: 60, v: 0.9, sinceMoveMs: 16 }, true],
  [
    "flicked, then held still before lifting",
    { dx: 60, v: 0.9, sinceMoveMs: 300 },
    false,
  ],
])("a release %s goes back: %s", (_, drag, expected) => {
  expect(commitsBack({ width, ...drag })).toBe(expected);
});
