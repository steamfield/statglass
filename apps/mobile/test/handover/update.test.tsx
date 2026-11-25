import type {
  BundleReconcile,
  CommandError,
  HostRecord,
  OfferedHost,
} from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, ok } from "@test/transport/fake-native";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { PermissionStatus } from "expo";
import { Camera, CameraView } from "expo-camera";
import * as Device from "expo-device";
import { UpdateFlow } from "@/handover/update-flow";
import { createNativeTransport } from "@/transport";

const updateCode = "SGB1:bundle";
const existingId = "old-host";
const changedId = "changed-host";
const offered = (id: string, name: string): OfferedHost => ({
  id,
  name,
  os: "Linux",
  user: "ops",
  port: null,
  targets: [{ route: "lan", host: `${id}.local` }],
  host_keys: [{ algorithm: "ssh-ed25519", sha256: "SHA256:pin" }],
});
const first = offered("first-host", "CI server");
const second = offered("second-host", "Backup server");

const reconcile: BundleReconcile = {
  from: "source-mac",
  preview_id: 17,
  new: [first, second],
  changed: [changedId],
  removed: [existingId],
  unavailable: [
    { id: "jump-host", name: "Build warehouse", reason: "proxy_jump" },
  ],
};

const failure = (error: CommandError) =>
  JSON.stringify({ status: "error", error });

async function showUpdate(diff = reconcile) {
  const native = new FakeNative();
  const [example] = await createMockTransport().listHosts();
  if (!example) throw new Error("Expected a host fixture");
  const existing: HostRecord = {
    ...example,
    id: existingId,
    display_name: "Old server",
  };
  const changed: HostRecord = {
    ...example,
    id: changedId,
    display_name: "Moving server",
  };
  let roster = [existing, changed];
  let saveUnavailable = false;
  let removeUnavailable = false;
  native.call.mockImplementation(async (method, args) => {
    switch (method) {
      case "decode_bundle":
        return (JSON.parse(args) as { text: string }).text === updateCode
          ? ok(diff)
          : failure({
              kind: "pairing",
              reason: "invalid",
              message:
                "Scan or paste an Update iPhone code from StatGlass on your Mac.",
            });
      case "list_hosts":
        return ok(roster);
      case "add_handover_hosts":
        if (
          (JSON.parse(args) as { preview_id: number }).preview_id !==
          diff.preview_id
        )
          return failure({
            kind: "pairing",
            reason: "invalid",
            message: "Open the host offer again before applying these changes.",
          });
        if (saveUnavailable)
          return failure({
            kind: "store",
            message: "Couldn’t save the host list.",
          });
        roster = roster.concat(
          (JSON.parse(args) as { hosts: OfferedHost[] }).hosts.map((host) => ({
            ...example,
            id: host.id,
            display_name: host.name,
          }))
        );
        return ok(null);
      case "remove_host":
        if (removeUnavailable)
          return failure({
            kind: "store",
            message: "Couldn’t remove the host.",
          });
        roster = roster.filter(
          (host) => host.id !== (JSON.parse(args) as { host: string }).host
        );
        return ok(null);
      default:
        return ok(null);
    }
  });
  const core = createNativeTransport(native);
  const done = jest.fn();
  await renderWithProviders(<UpdateFlow core={core} done={done} />, {
    transport: core,
    settings: { hostNames: { [existingId]: "Archive" } },
  });
  return {
    core,
    done,
    failSaving: (fail: boolean) => {
      saveUnavailable = fail;
    },
    failRemoving: (fail: boolean) => {
      removeUnavailable = fail;
    },
  };
}

const press = (name: string) =>
  fireEvent.press(screen.getByRole("button", { name }));

async function preview(text = updateCode) {
  await press("Paste code");
  await fireEvent.changeText(screen.getByLabelText("Update iPhone code"), text);
  await press("Review updates");
}

test("previews and applies selected hosts, then lets the user remove a marked host", async () => {
  const { core, done } = await showUpdate();
  await preview();
  const checkbox = (name: string) => screen.getByRole("checkbox", { name });
  expect(
    await screen.findByRole("checkbox", { name: "CI server", checked: true })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("checkbox", { name: "Backup server", checked: true })
  ).toBeOnTheScreen();
  expect(screen.getByText("Moving server")).toBeOnTheScreen();
  expect(screen.getByText("Archive")).toBeOnTheScreen();
  expect(screen.getByText("Removed on your Mac")).toBeOnTheScreen();
  expect(screen.getByText("SSH uses a jump host.")).toBeOnTheScreen();
  await fireEvent.press(checkbox("Backup server"));
  expect(
    screen.getByRole("checkbox", { name: "Backup server", checked: false })
  ).toBeOnTheScreen();
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    existingId,
    changedId,
  ]);
  await press("Apply updates");
  expect(
    await screen.findByRole("header", { name: "Hosts updated" })
  ).toBeOnTheScreen();
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    existingId,
    changedId,
    first.id,
  ]);
  await press("Remove Archive");
  await waitFor(() =>
    expect(screen.queryByText("Removed on your Mac")).toBeNull()
  );
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    changedId,
    first.id,
  ]);
  await press("Done");
  expect(done).toHaveBeenCalledWith(true);
});

test("asks for an update code on an empty paste or when a pairing code is pasted", async () => {
  await showUpdate();
  await press("Paste code");
  await press("Review updates");
  expect(
    screen.getByRole("alert", {
      name: "Paste an Update iPhone code to continue.",
    })
  ).toBeOnTheScreen();
  await fireEvent.changeText(
    screen.getByLabelText("Update iPhone code"),
    "SGP1:pair"
  );
  await press("Review updates");
  expect(
    await screen.findByRole("alert", {
      name: "Scan or paste an Update iPhone code from StatGlass on your Mac.",
    })
  ).toBeOnTheScreen();
  expect(screen.getByDisplayValue("SGP1:pair")).toBeOnTheScreen();
});

test("keeps the marked host and offers another Remove after a save failure", async () => {
  const { core, failRemoving } = await showUpdate({
    ...reconcile,
    new: [],
    changed: [],
  });
  await preview();
  await fireEvent.press(
    await screen.findByRole("button", { name: "Apply updates" })
  );
  failRemoving(true);
  await fireEvent.press(
    await screen.findByRole("button", { name: "Remove Archive" })
  );
  expect(
    await screen.findByRole("alert", { name: "Couldn’t remove the host." })
  ).toBeOnTheScreen();
  expect(screen.getByText("Removed on your Mac")).toBeOnTheScreen();
  expect((await core.listHosts()).map((host) => host.id)).toContain(existingId);
  failRemoving(false);
  await press("Remove Archive");
  await waitFor(() =>
    expect(screen.queryByText("Removed on your Mac")).toBeNull()
  );
  expect((await core.listHosts()).map((host) => host.id)).not.toContain(
    existingId
  );
});

test("offers Paste when the simulator has no camera and shows an empty update", async () => {
  const { core, done } = await showUpdate({
    ...reconcile,
    new: [],
    changed: [],
    removed: [],
    unavailable: [],
  });
  await press("Scan QR");
  expect(
    screen.getByText("Paste the Update iPhone code from your Mac to continue.")
  ).toBeOnTheScreen();
  await preview();
  expect(
    await screen.findByText("There are no host changes to apply.")
  ).toBeOnTheScreen();
  await press("Done");
  expect(done).toHaveBeenCalledWith(false);
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    existingId,
    changedId,
  ]);
});

test("scans an update QR after ignoring a pairing QR", async () => {
  jest.replaceProperty(Device, "isDevice", true);
  jest.spyOn(Camera, "getCameraPermissionsAsync").mockResolvedValue({
    status: PermissionStatus.GRANTED,
    granted: true,
    canAskAgain: true,
    expires: "never",
  });
  jest
    .spyOn(CameraView.prototype, "getAvailableLensesAsync")
    .mockResolvedValue([{ deviceType: "wide", localizedName: "Wide" }]);
  await showUpdate();
  await press("Scan QR");
  const scanner = await screen.findByLabelText("Update iPhone QR scanner");
  await fireEvent(scanner, "barcodeScanned", {
    nativeEvent: { type: "qr", data: "SGP1:pair" },
  });
  expect(screen.getByLabelText("Update iPhone QR scanner")).toBeOnTheScreen();
  await fireEvent(
    screen.getByLabelText("Update iPhone QR scanner"),
    "barcodeScanned",
    {
      nativeEvent: { type: "qr", data: updateCode },
    }
  );
  expect(
    await screen.findByRole("header", { name: "Review host updates" })
  ).toBeOnTheScreen();
});

test("keeps the selected hosts and removal preview when applying fails", async () => {
  const { core, failSaving } = await showUpdate();
  await preview();
  await fireEvent.press(
    await screen.findByRole("checkbox", { name: "Backup server" })
  );
  failSaving(true);
  await press("Apply updates");
  expect(
    await screen.findByRole("alert", { name: "Couldn’t save the host list." })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("checkbox", { name: "Backup server", checked: false })
  ).toBeOnTheScreen();
  expect(screen.getByText("Removed on your Mac")).toBeOnTheScreen();
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    existingId,
    changedId,
  ]);
  failSaving(false);
  await press("Apply updates");
  expect(
    await screen.findByRole("header", { name: "Hosts updated" })
  ).toBeOnTheScreen();
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    existingId,
    changedId,
    first.id,
  ]);
});
