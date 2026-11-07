import { sameHost } from "@core/query-keys";
import { expect, it } from "vitest";
import { holdWhile } from "./hold";

const next = ["history", "a", "events", 2] as const;

it("holds the previous answer when the predicate says it is the same identity", () => {
  const hold = holdWhile(next, sameHost);
  expect(hold("held", { queryKey: ["history", "a", "events", 1] })).toBe(
    "held"
  );
});

it("shows nothing for another identity or with no previous query", () => {
  const hold = holdWhile(next, sameHost);
  expect(
    hold("held", { queryKey: ["history", "b", "events", 1] })
  ).toBeUndefined();
  expect(hold("held", undefined)).toBeUndefined();
});
