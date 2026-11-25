import { commandErrorText } from "@core/command-error";
import { expect, jest, test } from "@jest/globals";
import { nativeBuildInfo } from "@/transport/build-info";
import {
  callCoreByMethod,
  createEventParser,
  preparePhoneKey,
} from "@/transport/envelope";
import { createNativeTransport } from "@/transport/native-transport";
import { BUILD_INFO, FakeNative, ok } from "./fake-native";

const lockedKey = Object.assign(
  new Error("Could not load the phone key (OSStatus -25308)"),
  { code: "ERR_STATGLASS_KEYCHAIN" }
);

const lockedNativeError = {
  source: "native",
  kind: "keychain",
  osStatus: -25308,
  message: "Could not load the phone key",
};

test("keeps a rejected native call typed through the transport", async () => {
  const native = new FakeNative();
  native.call.mockRejectedValueOnce(lockedKey);
  const transport = createNativeTransport(native);
  await expect(transport.authorizedKeyLine("iPhone")).rejects.toEqual(
    lockedNativeError
  );
});

test("preparing a key reports a locked phone and can be retried after unlocking", async () => {
  const native = Object.assign(new FakeNative(), {
    preparePhoneKey: jest
      .fn(async () => undefined)
      .mockRejectedValueOnce(lockedKey),
  });
  const preparing = preparePhoneKey(native);
  await expect(preparing).rejects.toEqual(lockedNativeError);
  const text = await preparing.catch((error: unknown) =>
    commandErrorText(error, "Could not prepare the phone key")
  );
  expect(text).toBe("Unlock this iPhone to connect");
  await expect(preparePhoneKey(native)).resolves.toBeUndefined();
});

test("diagnoses a native module without the key preparation method", async () => {
  await expect(preparePhoneKey(new FakeNative())).rejects.toThrow(
    "This build cannot prepare the phone key."
  );
});

test("keeps a typed core failure in its result envelope", async () => {
  const native = new FakeNative();
  const result = {
    status: "error",
    error: { kind: "remote_unsupported", message: "Update StatGlass" },
  };
  native.call.mockResolvedValueOnce(JSON.stringify(result));
  await expect(
    callCoreByMethod(native, {
      method: "network_addresses",
      args: { host: "lab" },
    })
  ).resolves.toEqual(result);
});

test("a generic native rejection keeps the command and its diagnostic", async () => {
  const native = new FakeNative();
  native.call.mockRejectedValueOnce(new Error("App context lost"));
  await expect(
    callCoreByMethod(native, { method: "build_info" })
  ).resolves.toEqual({
    status: "error",
    error: { kind: "internal", message: "build_info failed: App context lost" },
  });
});

test("decodes build info by method and diagnoses an empty reply", async () => {
  const native = new FakeNative();
  native.call.mockResolvedValueOnce(ok(BUILD_INFO)).mockResolvedValueOnce("");
  const result = await callCoreByMethod(native, { method: "build_info" });
  if (result.status !== "ok") throw new Error("Expected build info");
  expect(result.data.protocol_max).toBe(BUILD_INFO.protocol_max);
  await expect(
    callCoreByMethod(native, { method: "build_info" })
  ).resolves.toEqual({
    status: "error",
    error: { kind: "internal", message: 'Invalid core response: ""' },
  });
});

test("drops malformed events and warns once for each stream", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const first = createEventParser<{ kind: string }>("onLive");
    const second = createEventParser<{ kind: string }>("onLive");
    expect(first("bad")).toBeNull();
    expect(first('{"kind":"frame"}')).toEqual({ kind: "frame" });
    expect(first("still bad")).toBeNull();
    expect(second("bad")).toBeNull();
    expect(warn.mock.calls).toEqual([
      ["[native core] invalid onLive JSON", "bad"],
      ["[native core] invalid onLive JSON", "bad"],
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("logs the core's version error when About has no build info", () => {
  const native = new FakeNative();
  const error = { kind: "internal", message: "Could not read version" };
  native.version.mockReturnValueOnce(
    JSON.stringify({ status: "error", error })
  );
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(nativeBuildInfo(null)).toBeNull();
    expect(nativeBuildInfo(native)).toBeNull();
    expect(nativeBuildInfo(native)).toEqual(BUILD_INFO);
    expect(warn.mock.calls).toEqual([
      ["[native core] could not read version", error],
    ]);
  } finally {
    warn.mockRestore();
  }
});
