import { expect, test } from "@jest/globals";
import {
  ENTRANCE_WINDOW_MS,
  EntranceScope,
  entrancePlan,
  STAGGER_CAP,
} from "@/ui/entrance";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("units mounted together stagger in order, and a remount keeps its slot", () => {
  const time = clock();
  const scope = new EntranceScope(time.now);
  expect(["a", "b", "c"].map((unit) => scope.claim(unit))).toEqual([0, 1, 2]);
  // StrictMode renders twice; the second claim is the same slot.
  expect(scope.claim("b")).toBe(1);
});

test("content arriving later in the window starts its own batch", () => {
  const time = clock();
  const scope = new EntranceScope(time.now);
  scope.claim("pill");
  scope.claim("first card");
  time.advance(300);
  expect(scope.claim("late card")).toBe(0);
  expect(scope.claim("next late card")).toBe(1);
});

test("the window opens with the first content, not the screen", () => {
  const time = clock();
  const scope = new EntranceScope(time.now);
  // The hosts query answers after the window would have closed.
  time.advance(ENTRANCE_WINDOW_MS * 2);
  expect(scope.claim("first row")).toBe(0);
  expect(scope.claim("second row")).toBe(1);
});

test("after the window closes nothing enters", () => {
  const time = clock();
  const scope = new EntranceScope(time.now);
  scope.claim("first card");
  time.advance(ENTRANCE_WINDOW_MS + 1);
  expect(scope.claim("data update")).toBeNull();
  expect(entrancePlan(null, { page: 400, stagger: 40 })).toBeNull();
});

test("the stagger stops growing at the cap", () => {
  const motion = { page: 400, stagger: 40 };
  expect(entrancePlan(0, motion)).toEqual({ delay: 0, duration: 400 });
  expect(entrancePlan(STAGGER_CAP + 5, motion)).toEqual({
    delay: STAGGER_CAP * 40,
    duration: 400,
  });
});

test("Reduce Motion (a zero page token) means no entrance", () => {
  expect(entrancePlan(2, { page: 0, stagger: 0 })).toBeNull();
});
