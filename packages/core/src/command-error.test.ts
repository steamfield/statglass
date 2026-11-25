import { describe, expect, it } from "vitest";
import { commandError, commandErrorText, errorTone } from "./command-error";
import { CommandFailure } from "./transport/query";

describe("commandErrorText", () => {
  it("uses the message Rust attached to a result's error", () => {
    expect(
      commandErrorText({ kind: "docker", message: "Engine stopped." }, "x")
    ).toBe("Engine stopped.");
  });

  it("unwraps a query's CommandFailure instead of its kind-prefixed text", () => {
    const failure = new CommandFailure({ kind: "store", message: "Locked." });
    expect(failure.message).toBe("store: Locked.");
    expect(commandErrorText(failure, "x")).toBe("Locked.");
  });

  it("falls back for a kind without a message", () => {
    expect(
      commandErrorText({ kind: "history_unavailable" }, "History is off.")
    ).toBe("History is off.");
  });

  it("keeps a rejected call's own text, and falls back when it has none", () => {
    expect(commandErrorText(new Error("ipc closed"), "Try again.")).toBe(
      "ipc closed"
    );
    expect(commandErrorText("raw rejection", "Try again.")).toBe(
      "raw rejection"
    );
    expect(commandErrorText(new Error(""), "Try again.")).toBe("Try again.");
    expect(commandErrorText(undefined, "Try again.")).toBe("Try again.");
    expect(commandErrorText({ code: 1 }, "Try again.")).toBe("Try again.");
  });

  it("falls back for a typed error with an empty message", () => {
    expect(commandErrorText({ kind: "internal", message: "" }, "x")).toBe("x");
  });
});

describe("commandError", () => {
  it("returns the typed error or null", () => {
    const error = { kind: "internal", message: "m" } as const;
    expect(commandError(error)).toBe(error);
    expect(commandError(new CommandFailure(error))).toEqual(error);
    expect(commandError(new Error("m"))).toBeNull();
    expect(commandError(null)).toBeNull();
  });
});

describe("errorTone", () => {
  it("reads an expected absence as status and any other failure as an error", () => {
    expect(errorTone({ kind: "history_unavailable" })).toBe("status");
    expect(errorTone({ kind: "store_too_new", found: 9, supported: 8 })).toBe(
      "status"
    );
    expect(
      errorTone(new CommandFailure({ kind: "remote_host", host: "h" }))
    ).toBe("status");
    expect(errorTone({ kind: "remote_unsupported", message: "m" })).toBe(
      "status"
    );
    expect(errorTone({ kind: "docker", message: "m" })).toBe("error");
    expect(errorTone({ kind: "unknown_host", host: "h" })).toBe("error");
    expect(errorTone(new Error("ipc closed"))).toBe("error");
  });
});
