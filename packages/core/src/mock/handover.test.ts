import { createMockTransport } from "../mock-transport";
import { unwrap } from "../transport";

it("offers a bundle and records a retry that settles only the reachable host", async () => {
  const transport = createMockTransport({ autoTick: false });
  const offer = await unwrap(transport.handoverBundleStart());
  expect(offer.text).toMatch(/^SGB1:/);
  expect(offer.qr_svg).toContain("<svg");
  expect(offer.hosts).toEqual(["build-server", "Lab Mini"]);
  expect(offer.unavailable).toEqual([
    expect.objectContaining({ name: "Office server", reason: "proxy_jump" }),
  ]);

  const before = await unwrap(transport.deviceIntents());
  expect(before.map(({ state }) => state)).toEqual(["failed", "pending"]);
  await unwrap(transport.retryDeviceIntents());
  expect(await unwrap(transport.deviceIntents())).toEqual([
    expect.objectContaining({
      host_name: "build-server",
      op: "revoke",
      state: "failed",
      reason: "Host is offline.",
      attempts: 2,
    }),
  ]);
  expect(transport.calls.map(({ command }) => command)).toEqual([
    "handover_bundle_start",
    "device_intents",
    "retry_device_intents",
    "device_intents",
  ]);
  expect(
    await unwrap(createMockTransport({ autoTick: false }).deviceIntents())
  ).toEqual(before);
});

it("queues installs on approval and replaces them on revoke", async () => {
  let now = 1_800_000_000_000;
  const transport = createMockTransport({ autoTick: false, now: () => now });
  await unwrap(transport.updateSettings({ remote_access: { enabled: true } }));
  const offer = await unwrap(transport.pairingStart());
  now += 4000;
  const reply = await unwrap(transport.pairingApprove(offer.nonce));
  if (reply.kind !== "paired")
    throw new Error("The waiting iPhone should be paired");
  const access = async () =>
    (await unwrap(transport.deviceIntents())).filter(
      ({ device }) => device === reply.device
    );
  expect((await access()).map(({ host_name, op }) => [host_name, op])).toEqual([
    ["build-server", "install"],
    ["Lab Mini", "install"],
  ]);
  expect(await unwrap(transport.revokeDevice(reply.device))).toBe(true);
  await unwrap(transport.handoverBundleStart());
  expect((await access()).map(({ host_name, op }) => [host_name, op])).toEqual([
    ["build-server", "revoke"],
    ["Lab Mini", "revoke"],
  ]);
});
