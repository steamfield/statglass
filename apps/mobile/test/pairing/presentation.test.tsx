import { createMockPhonePairing } from "@core/mock/phone-pairing";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { PairingFlow } from "@/pairing";
import { PairingProvider } from "@/session/pairing";

const press = (name: string) =>
  fireEvent.press(screen.getByRole("button", { name }));

test("explains how to pair a Linux host directly and where to get the agent", async () => {
  await renderWithProviders(
    <PairingProvider>
      <PairingFlow onPaired={jest.fn()} onDone={jest.fn()} />
    </PairingProvider>
  );
  for (const instruction of [
    "For a Linux host no Mac monitors, connect over SSH. Run ~/.local/bin/statglass-agent pair as the user who installed the agent, or sudo /usr/local/bin/statglass-agent pair for a system install.",
    "2. Scan the QR code shown on the Mac or printed in the Linux terminal, or paste the pairing text.",
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

test("explains which hosts pairing with a Mac adds and how to get later additions", async () => {
  await renderWithProviders(
    <PairingProvider>
      <PairingFlow onPaired={jest.fn()} onDone={jest.fn()} />
    </PairingProvider>
  );
  for (const instruction of [
    "Create the code on a Mac running StatGlass to add it and the hosts it monitors, or on a Linux host running the agent.",
    "1. On the Mac, open StatGlass Settings › Paired devices › Pair iPhone. The Mac also offers to share the other hosts it monitors.",
    "If you add more hosts on the Mac later, choose Settings › Hosts › Update from Mac on your iPhone.",
  ]) {
    expect(screen.getByText(instruction)).toBeOnTheScreen();
  }
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
