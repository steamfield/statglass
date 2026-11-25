import type { MobileEvent } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderRouter, testRouter } from "expo-router/testing-library";
import { Appearance, Share } from "react-native";
import AppearanceSettings from "@/app/settings/appearance";
import DataSettings from "@/app/settings/data";
import DeviceSettings from "@/app/settings/device";
import {
  PhoneSettingsProvider,
  type PhoneSettingsStorage,
} from "@/data/phone-settings";
import { createNativeTransport, NativeCoreBridge } from "@/transport";

const app = "./src/app";
const liveSwitch = () =>
  screen.getByRole("switch", { name: "Live updates on cellular" });

function storageFixture(initial: string | null = null) {
  let content = initial;
  return {
    read: jest.fn<PhoneSettingsStorage["read"]>(() => content),
    write: jest.fn<PhoneSettingsStorage["write"]>((text) => {
      content = text;
    }),
  };
}

async function renderSettings(storage: PhoneSettingsStorage) {
  return renderWithProviders(
    <PhoneSettingsProvider storage={storage}>
      <AppearanceSettings />
      <DataSettings />
    </PhoneSettingsProvider>,
    { settings: {} }
  );
}

test("waits for settings before showing children and applies the restored appearance", async () => {
  const storage = storageFixture();
  const read = Promise.withResolvers<string>();
  storage.read.mockReturnValueOnce(read.promise);
  const scheme = jest
    .spyOn(Appearance, "setColorScheme")
    .mockImplementation(() => undefined);
  const view = await renderSettings(storage);
  expect(screen.queryByRole("radio", { name: "Dark" })).toBeNull();

  await act(() =>
    read.resolve(JSON.stringify({ appearance: "dark", liveOnCellular: false }))
  );
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(liveSwitch()).not.toBeChecked();
  expect(scheme).toHaveBeenLastCalledWith("dark");
  await view.rerender(
    <PhoneSettingsProvider storage={storage}>
      <DataSettings />
    </PhoneSettingsProvider>
  );
  expect(storage.read).toHaveBeenCalledTimes(1);
  expect(storage.write).not.toHaveBeenCalled();
});

test("debounces changes for 500 ms and restores them on the next mount", async () => {
  jest.useFakeTimers();
  const storage = storageFixture();
  try {
    const view = await renderSettings(storage);
    await fireEvent(liveSwitch(), "valueChange", false);
    await act(() => jest.advanceTimersByTimeAsync(250));
    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    await act(() => jest.advanceTimersByTimeAsync(499));
    expect(storage.write).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(storage.write).toHaveBeenCalledTimes(1);

    await view.unmount();
    await renderSettings(storage);
    expect(storage.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(liveSwitch()).not.toBeChecked();
  } finally {
    jest.useRealTimers();
  }
});

test.each(["{broken", '{"hostOrder":null}'])(
  "uses defaults for corrupt settings %j",
  async (text) => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const storage = storageFixture(text);
    await renderSettings(storage);
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(liveSwitch()).toBeChecked();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[phone settings] Could not read settings",
      expect.any(Error)
    );
    expect(storage.write).not.toHaveBeenCalled();
  }
);

test("logs subsequent write failures only once per session", async () => {
  jest.useFakeTimers();
  try {
    const storage = storageFixture();
    storage.write.mockRejectedValue(new Error("Disk unavailable"));
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await renderSettings(storage);
    for (const value of [false, true]) {
      await fireEvent(liveSwitch(), "valueChange", value);
      await act(() => jest.advanceTimersByTimeAsync(500));
    }
    expect(storage.write).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[phone settings] Could not save settings",
      expect.any(Error)
    );
    expect(liveSwitch()).toBeChecked();
  } finally {
    jest.useRealTimers();
  }
});

test("shows a failed data policy push inline until a later push succeeds", async () => {
  const native = new FakeNative();
  const warning = jest
    .spyOn(console, "warn")
    .mockImplementation(() => undefined);
  await renderWithProviders(
    <>
      <NativeCoreBridge />
      <DataSettings />
    </>,
    { transport: createNativeTransport(native), settings: {} }
  );
  native.call.mockResolvedValueOnce(
    JSON.stringify({
      status: "error",
      error: { kind: "internal", message: "Core is busy." },
    })
  );
  await fireEvent(liveSwitch(), "valueChange", false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t apply the data setting. Core is busy."
  );
  expect(warning).toHaveBeenCalledTimes(1);
  await fireEvent(liveSwitch(), "valueChange", true);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows and shares the phone’s key with App Lock still present", async () => {
  const native = new FakeNative();
  const key = "ecdsa-sha2-nistp256 test-key statglass-mobile";
  native.call.mockResolvedValueOnce(ok(key));
  const share = jest
    .spyOn(Share, "share")
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  await renderWithProviders(<DeviceSettings />, {
    transport: createNativeTransport(native),
  });
  expect(await screen.findByText(key)).toBeOnTheScreen();
  expect(screen.getByRole("switch", { name: "App Lock" })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Copy" }));
  const [method, args] = native.call.mock.calls[0] ?? [];
  expect(method).toBe("authorized_key_line");
  expect(args && JSON.parse(args)).toEqual({ comment: "statglass-mobile" });
  expect(share).toHaveBeenCalledWith({ message: key });
});

test("shows a temporary key failure and lets the user retry without leaving This iPhone", async () => {
  const native = new FakeNative();
  const key = "ecdsa-sha2-nistp256 test-key statglass-mobile";
  native.call.mockRejectedValueOnce(new Error("Keychain is locked."));
  native.call.mockResolvedValueOnce(ok(key));
  await renderWithProviders(<DeviceSettings />, {
    transport: createNativeTransport(native),
  });
  expect(await screen.findByText(/Keychain is locked/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(key)).toBeOnTheScreen();
});

test("keeps a host on failure and clears its phone name and order after removal", async () => {
  const native = new FakeNative();
  const [primary] = await createMockTransport().listHosts();
  if (!primary) throw new Error("Expected a host fixture");
  const backup = { ...primary, id: "backup", display_name: "Backup server" };
  let records = [primary, backup];
  let removed = false;
  let fail = true;
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts") return ok(removed ? [backup] : records);
    if (method !== "remove_host") return ok(null);
    if (fail) {
      return JSON.stringify({
        status: "error",
        error: { kind: "internal", message: "Host removal is busy." },
      });
    }
    removed = true;
    return ok(null);
  });
  installNative(native);
  const router = await renderRouter(app, { initialUrl: "/settings/hosts" });
  const rename = await screen.findByRole("button", {
    name: "Rename MacBook Pro",
  });
  await fireEvent.press(rename);
  await fireEvent.changeText(
    screen.getByLabelText("Name on this iPhone"),
    "Build laptop"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Save name" }));
  await fireEvent.press(
    screen.getByRole("button", { name: "Move Build laptop down" })
  );
  const remove = { name: "Remove Build laptop" };
  await fireEvent.press(await screen.findByRole("button", remove));
  await fireEvent.press(screen.getByRole("button", { name: "Remove host" }));
  expect(
    await screen.findByRole("alert", { name: "Host removal is busy." })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", remove)).toBeOnTheScreen();

  fail = false;
  await fireEvent.press(screen.getByRole("button", remove));
  await fireEvent.press(screen.getByRole("button", { name: "Remove host" }));
  expect(await screen.findByText("Backup server")).toBeOnTheScreen();
  expect(screen.queryByRole("button", remove)).toBeNull();
  const removal = native.call.mock.calls.find(
    ([method]) => method === "remove_host"
  );
  expect(removal && JSON.parse(removal[1])).toEqual({ host: primary.id });

  // The returned host follows the existing order along with other new hosts.
  removed = false;
  const newcomer = { ...backup, id: "new", display_name: "New server" };
  records = [newcomer, primary, backup];
  await act(() =>
    native.emit("onCoreEvent", {
      event: JSON.stringify({
        kind: "hosts_changed",
        hosts: records,
      } satisfies MobileEvent),
    })
  );
  expect(
    await screen.findByRole("button", { name: "Rename MacBook Pro" })
  ).toBeOnTheScreen();
  expect(screen.getAllByRole("button", { name: /^Rename / })).toEqual([
    screen.getByRole("button", { name: "Rename Backup server" }),
    screen.getByRole("button", { name: "Rename New server" }),
    screen.getByRole("button", { name: "Rename MacBook Pro" }),
  ]);

  await fireEvent.press(
    screen.getByRole("button", { name: "Update from Mac" })
  );
  expect(router.getPathname()).toBe("/update-from-mac");
  expect(
    await screen.findByRole("header", { name: "Not built yet" })
  ).toBeOnTheScreen();
  await testRouter.back("/settings/hosts");
  await fireEvent.press(screen.getByRole("button", { name: "Add a host" }));
  expect(router.getPathname()).toBe("/pair");
  expect(
    await screen.findByRole("button", { name: "Paste code" })
  ).toBeOnTheScreen();
});

test("finishing a pending removal preserves an edit made after reopening Hosts", async () => {
  const native = new FakeNative();
  const [primary] = await createMockTransport().listHosts();
  if (!primary) throw new Error("Expected a host fixture");
  const backup = { ...primary, id: "backup", display_name: "Backup server" };
  const pending = Promise.withResolvers<void>();
  let removed = false;
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts")
      return ok(removed ? [backup] : [primary, backup]);
    if (method === "remove_host") {
      await pending.promise;
      removed = true;
    }
    return ok(null);
  });
  installNative(native);
  await renderRouter(app, { initialUrl: "/settings" });
  await fireEvent.press(await screen.findByRole("button", { name: "Hosts" }));
  const remove = { name: "Remove MacBook Pro" };
  await fireEvent.press(await screen.findByRole("button", remove));
  await fireEvent.press(screen.getByRole("button", { name: "Remove host" }));
  await testRouter.back("/settings");
  await fireEvent.press(screen.getByRole("button", { name: "Hosts" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: "Rename Backup server" })
  );
  await fireEvent.changeText(
    screen.getByLabelText("Name on this iPhone"),
    "Offsite backup"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Save name" }));
  await act(() => pending.resolve());
  expect(
    screen.getByRole("button", { name: "Rename Offsite backup" })
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", remove)).toBeNull();
});
