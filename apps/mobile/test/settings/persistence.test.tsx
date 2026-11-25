import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Appearance } from "react-native";
import AppearanceSettings from "@/app/settings/appearance";
import DataSettings from "@/app/settings/data";
import {
  PhoneSettingsProvider,
  type PhoneSettingsStorage,
} from "@/data/phone-settings";
import { createNativeTransport, NativeCoreBridge } from "@/transport";

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
  expect(screen.queryByRole("button", { name: "Dark" })).toBeNull();

  await act(() =>
    read.resolve(JSON.stringify({ appearance: "dark", liveOnCellular: false }))
  );
  expect(screen.getByRole("button", { name: "Dark" })).toBeSelected();
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
    await fireEvent.press(screen.getByRole("button", { name: "Dark" }));
    await act(() => jest.advanceTimersByTimeAsync(499));
    expect(storage.write).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(storage.write).toHaveBeenCalledTimes(1);

    await view.unmount();
    await renderSettings(storage);
    expect(storage.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Dark" })).toBeSelected();
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
    expect(screen.getByRole("button", { name: "System" })).toBeSelected();
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
