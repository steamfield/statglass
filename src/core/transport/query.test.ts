import { expect, it } from "vitest";
import { CommandFailure, unwrap } from "./query";

it("throws a typed command error as a CommandFailure", async () => {
  const failure = await unwrap(
    Promise.resolve({
      status: "error",
      error: { kind: "invalid_argument", message: "bad range" },
    } as const)
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(CommandFailure);
  expect(failure instanceof CommandFailure && failure.error.kind).toBe(
    "invalid_argument"
  );
});
