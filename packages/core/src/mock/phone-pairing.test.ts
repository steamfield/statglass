import { createMockPhonePairing } from "./phone-pairing";

it("previews without waiting and approves on the next tick", async () => {
  const pairing = createMockPhonePairing({ now: () => 1_000 });
  const offer = await pairing.previewPairing(" SGPDEMO:approve\n");
  expect(offer).toMatchObject({
    status: "ok",
    data: { code: "ABC123", expires_ms: 61_000 },
  });
  const approved = vi.fn();
  const result = pairing
    .pair("SGPDEMO:approve", "Test iPhone", "iPhone")
    .then(approved);
  await Promise.resolve();
  expect(approved).not.toHaveBeenCalled();
  pairing.tick();
  await result;
  expect(approved).toHaveBeenCalledWith({
    status: "ok",
    data: {
      id: offer.status === "ok" ? offer.data.host_id : undefined,
      name: "MacBook Pro",
    },
  });
});

it.each(["SGP1:broken", "SGPDEMO:bad-scenario", ""])(
  "rejects an invalid preview for %j",
  async (text) => {
    await expect(
      createMockPhonePairing().previewPairing(text)
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "pairing", reason: "invalid" },
    });
  }
);
