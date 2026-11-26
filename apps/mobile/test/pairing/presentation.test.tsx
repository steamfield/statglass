import { createMockPhonePairing } from "@core/mock/phone-pairing";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { PairingFlow } from "@/pairing";
import { PairingProvider } from "@/session/pairing";

const press = (name: string) =>
  fireEvent.press(screen.getByRole("button", { name }));

test("gives setup steps and install guidance before asking for a code", async () => {
  await renderWithProviders(
    <PairingProvider>
      <PairingFlow onPaired={jest.fn()} onDone={jest.fn()} />
    </PairingProvider>
  );
  for (const instruction of [
    /1\. On a Mac, open StatGlass Settings and choose Pair iPhone/,
    "sudo statglass-agent pair",
    "2. Scan the code or paste it.",
    "3. Approve on the host.",
    "4. Done.",
    "Host doesn't have StatGlass yet?",
    "https://github.com/steamfield/statglass/releases/latest",
    /The Linux agent is installed from the Mac app.*Monitor a Linux host/,
    "What the phone can see",
    /This iPhone gets a read-only, restricted key/,
  ]) {
    expect(screen.getByText(instruction)).toBeOnTheScreen();
  }
  expect(screen.getByRole("button", { name: "Scan QR" })).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Paste code" })).toBeOnTheScreen();
});

test("shows that a code is being read and returns to setup on Cancel", async () => {
  const pairing = createMockPhonePairing();
  const pending = Promise.withResolvers<void>();
  await renderWithProviders(
    <PairingProvider
      pairing={{
        ...pairing,
        async previewPairing(text) {
          await pending.promise;
          return pairing.previewPairing(text);
        },
      }}
    >
      <PairingFlow onPaired={jest.fn()} onDone={jest.fn()} />
    </PairingProvider>
  );
  await press("Paste code");
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code"),
    "SGPDEMO:approve"
  );
  await press("Preview host");
  expect(
    screen.getByRole("header", { name: "Reading pairing code…" })
  ).toBeOnTheScreen();
  await press("Cancel");
  await act(() => pending.resolve());
  expect(
    screen.getByRole("header", { name: "Get a pairing code" })
  ).toBeOnTheScreen();
});
