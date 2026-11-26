/** Exercises the screen actions against the real transport providers. */
import { createMockTransport } from "@core/mock-transport";
import { expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import type { PhoneTransport } from "@/data/seam";
import { useIsDemo, useOptionalPhoneTransport } from "@/data/transport-context";
import { useClearTransport, useSelectNativeCore } from "@/session/selection";
import { CoreProvider, useNativeCore } from "@/transport";

function SelectionControls({ expected }: { expected?: PhoneTransport }) {
  const { core } = useNativeCore();
  const transport = useOptionalPhoneTransport();
  const demo = useIsDemo();
  const select = useSelectNativeCore();
  const clear = useClearTransport();
  const [changed, setChanged] = useState<boolean | null>(null);
  return (
    <>
      <Text>{core ? "Core ready" : "Core pending"}</Text>
      <Text>
        {transport === null
          ? "Nothing selected"
          : transport === core
            ? "Core selected"
            : demo
              ? "Demo selected"
              : "Other transport selected"}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setChanged(select())}
      >
        <Text>Select core</Text>
      </Pressable>
      {changed !== null && <Text>Selection changed: {String(changed)}</Text>}
      {expected && (
        <Pressable accessibilityRole="button" onPress={() => clear(expected)}>
          <Text>Clear expected transport</Text>
        </Pressable>
      )}
    </>
  );
}

function installEmptyCore() {
  const native = new FakeNative();
  native.call.mockResolvedValue(ok([]));
  installNative(native);
  return native;
}

test("keeps the demo selected while the native core starts", async () => {
  const native = installEmptyCore();
  const start = Promise.withResolvers<string>();
  native.start.mockReturnValueOnce(start.promise);
  await renderWithProviders(
    <CoreProvider>
      <SelectionControls />
    </CoreProvider>,
    { transport: createMockTransport(), demo: true }
  );
  try {
    expect(screen.getByText("Core pending")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Select core" }));
    expect(screen.getByText("Selection changed: false")).toBeOnTheScreen();
    expect(screen.getByText("Demo selected")).toBeOnTheScreen();
  } finally {
    await act(() => start.resolve(ok(null)));
  }
});

test.each(["Demo selected", "Nothing selected"] as const)(
  "selects the ready core from %s and reports no change the second time",
  async (initialLabel) => {
    installEmptyCore();
    await renderWithProviders(
      <CoreProvider>
        <SelectionControls />
      </CoreProvider>,
      initialLabel === "Demo selected"
        ? { transport: createMockTransport(), demo: true }
        : {}
    );
    expect(await screen.findByText("Core ready")).toBeOnTheScreen();
    expect(screen.getByText(initialLabel)).toBeOnTheScreen();
    const select = () =>
      fireEvent.press(screen.getByRole("button", { name: "Select core" }));

    await select();
    expect(screen.getByText("Selection changed: true")).toBeOnTheScreen();
    expect(screen.getByText("Core selected")).toBeOnTheScreen();

    await select();
    expect(screen.getByText("Selection changed: false")).toBeOnTheScreen();
    expect(screen.getByText("Core selected")).toBeOnTheScreen();
  }
);

test("reports only one change when a consumer selects the core twice before a render", async () => {
  installEmptyCore();
  function BatchedSelection() {
    const { core } = useNativeCore();
    const transport = useOptionalPhoneTransport();
    const select = useSelectNativeCore();
    const [changes, setChanges] = useState<string>();
    return (
      <>
        {core && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setChanges([select(), select()].join(", "))}
          >
            <Text>Select core twice</Text>
          </Pressable>
        )}
        {changes && <Text>{changes}</Text>}
        {core && transport === core && <Text>Core selected</Text>}
      </>
    );
  }
  await renderWithProviders(
    <CoreProvider>
      <BatchedSelection />
    </CoreProvider>
  );
  await fireEvent.press(
    await screen.findByRole("button", { name: "Select core twice" })
  );
  expect(screen.getByText("true, false")).toBeOnTheScreen();
  expect(screen.getByText("Core selected")).toBeOnTheScreen();
});

test("clears the transport when it is still the expected selection", async () => {
  const transport = createMockTransport();
  await renderWithProviders(<SelectionControls expected={transport} />, {
    transport,
  });
  expect(screen.getByText("Other transport selected")).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Clear expected transport" })
  );
  expect(screen.getByText("Nothing selected")).toBeOnTheScreen();
});

test("keeps a new selection when a caller clears the previous transport", async () => {
  installEmptyCore();
  const transport = createMockTransport();
  await renderWithProviders(
    <CoreProvider>
      <SelectionControls expected={transport} />
    </CoreProvider>,
    { transport, demo: true }
  );
  expect(await screen.findByText("Core ready")).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Select core" }));
  expect(screen.getByText("Core selected")).toBeOnTheScreen();

  await fireEvent.press(
    screen.getByRole("button", { name: "Clear expected transport" })
  );
  expect(screen.getByText("Core selected")).toBeOnTheScreen();
});
