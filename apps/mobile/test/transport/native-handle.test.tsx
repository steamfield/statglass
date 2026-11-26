/** Checks which native transport a consumer gets from the real providers. */
import { createMockTransport } from "@core/mock-transport";
import { expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import {
  CoreProvider,
  createNativeTransport,
  useNativeCore,
  useNativeHandle,
} from "@/transport";

function NativeConsumer() {
  const { core } = useNativeCore();
  const selected = useOptionalPhoneTransport();
  const native = useNativeHandle();
  if (native === null) return <Text>No native handle</Text>;
  if (native === core) return <Text>Started core</Text>;
  if (native === selected) return <Text>Selected native transport</Text>;
  return <Text>Unexpected native handle</Text>;
}

test("prefers the started core over the selected native transport", async () => {
  const native = new FakeNative();
  native.call.mockResolvedValue(ok([]));
  installNative(native);
  const selected = createNativeTransport(new FakeNative());
  try {
    await renderWithProviders(
      <CoreProvider>
        <NativeConsumer />
      </CoreProvider>,
      { transport: selected }
    );
    expect(await screen.findByText("Started core")).toBeOnTheScreen();
  } finally {
    selected.dispose();
  }
});

test("uses the selected native transport when no core is exposed", async () => {
  const selected = createNativeTransport(new FakeNative());
  try {
    await renderWithProviders(<NativeConsumer />, { transport: selected });
    expect(screen.getByText("Selected native transport")).toBeOnTheScreen();
  } finally {
    selected.dispose();
  }
});

test("has no native handle for a demo session without a core", async () => {
  await renderWithProviders(<NativeConsumer />, {
    transport: createMockTransport(),
    demo: true,
  });
  expect(screen.getByText("No native handle")).toBeOnTheScreen();
});
