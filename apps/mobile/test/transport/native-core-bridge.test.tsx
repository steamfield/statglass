import { createMockTransport } from "@core/mock-transport";
import { expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import DataSettings from "@/app/settings/data";
import { createNativeTransport, NativeCoreBridge } from "@/transport";

test("applies rapid cellular settings in order while the first write is pending", async () => {
  const native = new FakeNative();
  const reply = Promise.withResolvers<string>();
  native.call.mockReturnValueOnce(reply.promise);
  const transport = createNativeTransport(native);
  await renderWithProviders(
    <>
      <NativeCoreBridge />
      <DataSettings />
    </>,
    { transport }
  );
  const live = () =>
    screen.getByRole("switch", { name: "Live updates on cellular" });
  await fireEvent(live(), "valueChange", false);
  await fireEvent(live(), "valueChange", true);
  expect(native.call.mock.calls).toEqual([
    ["set_data_policy", '{"live_on_cellular":true}'],
  ]);
  await act(() => reply.resolve(ok(null)));
  expect(native.call.mock.calls).toEqual([
    ["set_data_policy", '{"live_on_cellular":true}'],
    ["set_data_policy", '{"live_on_cellular":false}'],
    ["set_data_policy", '{"live_on_cellular":true}'],
  ]);
  transport.dispose();
});

test("sends only the current live policy on mount and change for a native transport", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  await renderWithProviders(
    <>
      <NativeCoreBridge />
      <DataSettings />
    </>,
    { transport }
  );
  expect(native.call.mock.calls).toEqual([
    ["set_data_policy", '{"live_on_cellular":true}'],
  ]);
  await fireEvent(
    screen.getByRole("switch", { name: "Sync history on cellular" }),
    "valueChange",
    true
  );
  expect(native.call).toHaveBeenCalledTimes(1);
  await fireEvent(
    screen.getByRole("switch", { name: "Live updates on cellular" }),
    "valueChange",
    false
  );
  expect(native.call.mock.calls).toEqual([
    ["set_data_policy", '{"live_on_cellular":true}'],
    ["set_data_policy", '{"live_on_cellular":false}'],
  ]);
  transport.dispose();
});

test("can change cellular settings with the real demo transport chosen", async () => {
  const native = new FakeNative();
  installNative(native);
  const transport = createMockTransport();
  await renderWithProviders(
    <>
      <NativeCoreBridge />
      <DataSettings />
    </>,
    { transport, demo: true }
  );
  const live = () =>
    screen.getByRole("switch", { name: "Live updates on cellular" });
  expect(live()).toBeChecked();
  await fireEvent(live(), "valueChange", false);
  expect(live()).not.toBeChecked();
  expect(native.call).not.toHaveBeenCalled();
});
