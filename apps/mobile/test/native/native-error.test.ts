import { expect, test } from "@jest/globals";
import { toNativeModuleError } from "@native/statglass-native";

function rejection(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

test.each([
  ["ERR_STATGLASS_KEYCHAIN", "keychain"],
  ["ERR_STATGLASS_SECURE_ENCLAVE", "secureEnclave"],
  ["ERR_STATGLASS_CAMERA", "camera"],
  ["ERR_STATGLASS_LOCAL_NETWORK", "localNetwork"],
])("recognizes %s with or without an OSStatus", (code, kind) => {
  expect(
    toNativeModuleError(rejection(code, "unavailable (OSStatus -25300)"))
  ).toEqual({ kind, osStatus: -25300, message: "unavailable" });
  expect(toNativeModuleError(rejection(code, "unavailable"))).toEqual({
    kind,
    osStatus: null,
    message: "unavailable",
  });
});

test.each([
  ["a plain Error", new Error("unavailable")],
  ["a string", "ERR_STATGLASS_KEYCHAIN"],
  ["null", null],
  ["an unknown code", rejection("ERR_STATGLASS_OTHER", "unavailable")],
  ["a malformed rejection", { code: "ERR_STATGLASS_KEYCHAIN" }],
])("ignores %s", (_description, value) => {
  expect(toNativeModuleError(value)).toBeNull();
});
