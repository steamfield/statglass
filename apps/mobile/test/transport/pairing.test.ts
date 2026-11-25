import type { PairingPreview } from "@core/generated/types";
import { expect, test } from "@jest/globals";
import { FakeNative, ok } from "@test/transport/fake-native";
import {
  createNativeTransport,
  nativePairing,
} from "@/transport/native-transport";

test("previews without creating the key and sends the named device after confirmation", async () => {
  const native = new FakeNative();
  const pairing = nativePairing(createNativeTransport(native));
  const preview = {
    host_id: "host",
    name: "Build host",
    os: "Linux",
    user: "statglass",
    code: "ABC123",
    targets: [{ route: "lan", host: "build.local" }],
    expires_ms: 123_456,
    can_hand_over: false,
  } satisfies PairingPreview;
  native.call.mockResolvedValueOnce(ok(preview));

  expect(await pairing.previewPairing("SGP1:offer")).toEqual({
    status: "ok",
    data: preview,
  });
  expect(native.preparePhoneKey).not.toHaveBeenCalled();
  const [previewMethod, previewArgs] = native.call.mock.calls[0] ?? [];
  expect(previewMethod).toBe("preview_pairing");
  expect(previewArgs && JSON.parse(previewArgs)).toEqual({
    text: "SGP1:offer",
  });

  native.call.mockImplementationOnce(async () => {
    expect(native.preparePhoneKey).toHaveBeenCalledTimes(1);
    return ok({ id: "host", name: "Build host" });
  });
  expect(
    await pairing.pair("SGP1:offer", "Alex’s iPhone", "iPhone")
  ).toMatchObject({ status: "ok" });
  const [pairMethod, pairArgs] = native.call.mock.calls.at(-1) ?? [];
  expect(pairMethod).toBe("pair");
  expect(pairArgs && JSON.parse(pairArgs)).toEqual({
    text: "SGP1:offer",
    device_name: "Alex’s iPhone",
    model: "iPhone",
  });
});

test("preserves the native key error and makes no pairing attempt", async () => {
  const native = new FakeNative();
  native.preparePhoneKey.mockRejectedValueOnce({
    code: "ERR_STATGLASS_KEYCHAIN",
    message: "The phone is locked. (OSStatus -25308)",
  });
  const pairing = nativePairing(createNativeTransport(native));
  await expect(pairing.pair("SGP1:offer", "iPhone", "iPhone")).rejects.toEqual({
    source: "native",
    kind: "keychain",
    osStatus: -25308,
    message: "The phone is locked.",
  });
  expect(native.call).not.toHaveBeenCalled();
});
