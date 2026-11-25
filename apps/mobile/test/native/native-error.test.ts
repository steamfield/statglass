import { expect, test } from "@jest/globals";
import { toNativeModuleError } from "@native/statglass-native";

function rejection(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

test.each([
  [
    "ERR_STATGLASS_KEYCHAIN",
    "Could not load the phone key (OSStatus -25300)",
    {
      kind: "keychain",
      osStatus: -25300,
      message: "Could not load the phone key",
    },
  ],
  [
    "ERR_STATGLASS_KEYCHAIN",
    "Could not sign with the phone key (OSStatus -25308)",
    {
      kind: "keychain",
      osStatus: -25308,
      message: "Could not sign with the phone key",
    },
  ],
  [
    "ERR_STATGLASS_SECURE_ENCLAVE",
    "Could not create the phone key (OSStatus -50)",
    {
      kind: "secureEnclave",
      osStatus: -50,
      message: "Could not create the phone key",
    },
  ],
  [
    "ERR_STATGLASS_CAMERA",
    "Could not access the camera",
    { kind: "camera", osStatus: null, message: "Could not access the camera" },
  ],
])("decodes %s with message %s", (code, message, expected) => {
  expect(toNativeModuleError(rejection(code, message))).toEqual(expected);
});

test.each([
  ["a plain Error", new Error("unavailable")],
  ["a string", "ERR_STATGLASS_KEYCHAIN"],
  ["null", null],
  ["an unknown code", rejection("ERR_STATGLASS_OTHER", "unavailable")],
  [
    "the retired Local Network code",
    rejection("ERR_STATGLASS_LOCAL_NETWORK", "unavailable"),
  ],
  ["a malformed rejection", { code: "ERR_STATGLASS_KEYCHAIN" }],
])("ignores %s", (_description, value) => {
  expect(toNativeModuleError(value)).toBeNull();
});
