/** Navigation after applying host updates through the app's real routes. */
import type {
  BundleReconcile,
  HostRecord,
  OfferedHost,
} from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, test } from "@jest/globals";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { fireEvent, renderRouter, screen } from "expo-router/testing-library";

const UPDATE_CODE = "SGB1:update";
const UPDATED_HOST: OfferedHost = {
  id: "ci-server",
  name: "CI server",
  os: "Linux",
  user: "ci",
  port: null,
  targets: [{ route: "lan", host: "ci.local" }],
  host_keys: [{ algorithm: "ssh-ed25519", sha256: "SHA256:pin" }],
};
const UPDATE: BundleReconcile = {
  from: "source-mac",
  preview_id: 17,
  new: [UPDATED_HOST],
  changed: [],
  removed: [],
  unavailable: [],
};

/**
 * Installs a native core with an update ready to apply.
 * @throws If the shared transport provides no host fixture.
 */
async function installUpdateCore(startInDemo: boolean) {
  const [fixture] = await createMockTransport({ historyRows: 2 }).listHosts();
  if (!fixture) throw new Error("Expected a host fixture");
  const existing = {
    ...fixture,
    is_local: false,
    display_name: "Existing server",
  };
  const added: HostRecord = {
    ...existing,
    id: UPDATED_HOST.id,
    display_name: UPDATED_HOST.name,
    info: { ...fixture.info, os: "linux" },
  };
  let roster = startInDemo ? [] : [existing];
  const native = new FakeNative();
  native.call.mockImplementation(async (method) => {
    switch (method) {
      case "list_hosts":
        return ok(roster);
      case "list_remote_hosts":
        return ok([]);
      case "pairing_state":
        return ok({ hosts: roster.length, key_changed: false });
      case "decode_bundle":
        return ok(UPDATE);
      case "add_handover_hosts":
        roster = [...roster, added];
        return ok(null);
      default:
        return ok(null);
    }
  });
  installNative(native);
}

async function press(name: string) {
  await fireEvent.press(await screen.findByRole("button", { name }));
}

async function openUpdateFromSettings() {
  await press("Settings");
  await press("Hosts");
  await press("Update from Mac");
}

async function applyUpdate() {
  await press("Paste code");
  await fireEvent.changeText(
    screen.getByLabelText("Update iPhone code"),
    UPDATE_CODE
  );
  await press("Review updates");
  await press("Apply updates");
  expect(
    await screen.findByRole("header", { name: "Hosts updated" })
  ).toBeOnTheScreen();
  await press("Done");
}

test("applying an update from demo opens the native hosts list", async () => {
  await installUpdateCore(true);
  const router = await renderRouter("./src/app", { initialUrl: "/" });
  await press("Try demo hosts");
  expect(await screen.findByRole("button", { name: "Demo" })).toBeOnTheScreen();

  await openUpdateFromSettings();
  await applyUpdate();

  expect(
    await screen.findByRole("button", { name: /^CI server,/ })
  ).toBeOnTheScreen();
  expect(router.getSegments()).toEqual(["(hosts)"]);
});

test("applying an update on the native core returns to Hosts settings", async () => {
  await installUpdateCore(false);
  const router = await renderRouter("./src/app", { initialUrl: "/" });
  expect(
    await screen.findByRole("button", { name: /^Existing server,/ })
  ).toBeOnTheScreen();

  await openUpdateFromSettings();
  await applyUpdate();

  expect(router.getPathname()).toBe("/settings/hosts");
  expect(
    await screen.findByRole("button", { name: "Update from Mac" })
  ).toBeOnTheScreen();
  await press("Back");
  expect(router.getPathname()).toBe("/settings");
});
