import { expect, test } from "vitest";
import { commandError, commandErrorText, errorTone } from "./command-error";
import { isNativeError, nativeErrorText } from "./native-errors";

const unlock = "Unlock with your passcode, then try again.";
const retryKey = "Try again. If the problem persists, pair this iPhone again.";

test.each([
  ["keychain", -25308, "Unlock this iPhone to connect", unlock],
  ["secureEnclave", -25308, "Unlock this iPhone to connect", unlock],
  [
    "keychain",
    -25300,
    "Phone key is missing",
    "Pair this iPhone with the host again.",
  ],
  ["keychain", -50, "Phone key is unavailable", retryKey],
  ["secureEnclave", null, "Secure Enclave key is unavailable", retryKey],
  [
    "camera",
    null,
    "Camera is unavailable",
    "Allow camera access for StatGlass in Settings to scan a pairing code.",
  ],
] as const)(
  "words a %s failure with status %s",
  (kind, osStatus, title, recovery) => {
    const error = { source: "native", kind, osStatus, message: "Diagnostic" };
    if (!isNativeError(error)) throw new Error("Expected a native error");
    expect(commandError(error)).toBeNull();
    expect(nativeErrorText(error)).toEqual({ title, recovery });
    expect(commandErrorText(error, "Connection failed")).toBe(title);
  }
);

test.each([
  null,
  { kind: "keychain", osStatus: -25308, message: "Locked" },
  { source: "native", kind: "internal", osStatus: null, message: "Failed" },
  { source: "native", kind: "localNetwork", osStatus: null, message: "Failed" },
  { source: "native", kind: "keychain", osStatus: "-25308", message: "Locked" },
])("rejects a value outside the native error contract (%j)", (error) => {
  expect(isNativeError(error)).toBe(false);
});

test("a host's refusal of a query is a status", () => {
  expect(errorTone({ kind: "remote_refused", message: "Query refused" })).toBe(
    "status"
  );
});

test("words an unavailable phone key without a native diagnostic", () => {
  expect(
    commandErrorText({ kind: "phone_key_unavailable" }, "Could not read key")
  ).toBe(
    "This iPhone’s key is unavailable. Unlock this iPhone or pair it again."
  );
});
