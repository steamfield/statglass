import { expect, it } from "vitest";
import { asCommandFailure, CommandFailure, unwrap } from "./query";

it("narrows a command failure and nothing else", async () => {
  const failure = await unwrap(
    Promise.resolve({
      status: "error",
      error: { kind: "invalid_argument", message: "bad range" },
    } as const)
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(CommandFailure);
  expect(asCommandFailure(failure)?.error.kind).toBe("invalid_argument");
  expect(asCommandFailure(new Error("ipc rejected"))).toBeNull();
  expect(asCommandFailure(null)).toBeNull();
});
