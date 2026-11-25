import { readdirSync, readFileSync } from "node:fs";
import type { PairedHost, PairingPreview } from "@core/generated/types";
import { createMockPhonePairing } from "@core/mock/phone-pairing";
import type { CommandResult } from "@core/transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, ok } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { PairingProvider } from "@/data/pairing-context";
import type { PhonePairing } from "@/data/pairing-seam";
import { PairingFlow } from "@/pairing";
import { createNativeTransport, nativePairing } from "@/transport";

const press = (name: string) =>
  fireEvent.press(screen.getByRole("button", { name }));
const enter = (text: string) =>
  fireEvent.changeText(screen.getByLabelText("Pairing code"), text);

function offer(overrides: Partial<PairingPreview> = {}): PairingPreview {
  return {
    host_id: "builder",
    name: "Build host",
    os: "Linux",
    user: "statglass",
    targets: [
      { route: "lan", host: "build.local" },
      { route: "tailscale", host: "build.example" },
    ],
    code: "ABC123",
    expires_ms: Date.now() + 60_000,
    can_hand_over: false,
    ...overrides,
  };
}

function fixture(overrides?: Partial<PairingPreview>) {
  const pairing = {
    previewPairing: jest.fn<PhonePairing["previewPairing"]>(async () => ({
      status: "ok",
      data: offer(overrides),
    })),
    pair: jest.fn<PhonePairing["pair"]>(),
  };
  const pending = Promise.withResolvers<CommandResult<PairedHost>>();
  pairing.pair.mockReturnValue(pending.promise);
  return { pairing, pending };
}

async function renderFlow(pairing: PhonePairing) {
  const onPaired = jest.fn();
  const onDone = jest.fn();
  await renderWithProviders(
    <PairingProvider pairing={pairing}>
      <PairingFlow onPaired={onPaired} onDone={onDone} />
    </PairingProvider>
  );
  return { onPaired, onDone };
}

async function preview(text: string) {
  await press("Paste code");
  await enter(text);
  await press("Preview host");
}

test("keeps OS comparisons out of pairing decisions", () => {
  const directory = "./src/pairing";
  for (const path of readdirSync(directory, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!/\.tsx?$/.test(path)) continue;
    expect(readFileSync(`${directory}/${path}`, "utf8")).not.toMatch(
      /\bos\s*(?:===?|!==?)|["']macos["']\s*(?:===?|!==?)|switch\s*\([^)]*\bos\b/i
    );
  }
});

test("rejects an empty paste and previews a trimmed offer before dialing", async () => {
  // An agent OS with the capability proves the note follows the payload.
  const { pairing } = fixture({ can_hand_over: true });
  await renderFlow(pairing);
  await press("Paste code");
  await enter("  ");
  await press("Preview host");
  expect(
    screen.getByRole("alert", { name: "Paste a pairing code to continue." })
  ).toBeOnTheScreen();
  expect(pairing.previewPairing).not.toHaveBeenCalled();

  await enter("  SGP1:offer\n");
  await press("Preview host");
  expect(
    await screen.findByRole("header", { name: "Build host" })
  ).toBeOnTheScreen();
  for (const value of [
    "Linux",
    "User statglass",
    "LAN · build.local",
    "Tailscale · build.example",
    "ABC123",
  ]) {
    expect(screen.getByText(value)).toBeOnTheScreen();
  }
  expect(
    screen.getByText("Can also add the hosts it monitors")
  ).toBeOnTheScreen();
  expect(pairing.previewPairing).toHaveBeenCalledWith("SGP1:offer");
  expect(pairing.pair).not.toHaveBeenCalled();
});

test("shows the countdown and refuses to dial when it reaches zero", async () => {
  jest.useFakeTimers();
  try {
    const { pairing } = fixture({ expires_ms: Date.now() + 2000 });
    await renderFlow(pairing);
    await preview("SGP1:offer");
    expect(screen.getByText("Expires in 2s")).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTimeAsync(1000));
    expect(screen.getByText("Expires in 1s")).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTimeAsync(1000));
    expect(screen.getByText("Code expired")).toBeOnTheScreen();
    await press("Confirm");
    expect(
      screen.getByRole("alert", { name: "The pairing code expired." })
    ).toBeOnTheScreen();
    expect(pairing.pair).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test("shows the waiting code and leaves a late approval alone after Cancel", async () => {
  const { pairing, pending } = fixture({ os: "macOS 26" });
  const { onPaired } = await renderFlow(pairing);
  await preview("SGP1:offer");
  expect(screen.queryByText(/Can also add the hosts/)).toBeNull();
  await press("Confirm");
  expect(
    screen.getByRole("header", { name: "Waiting for approval on Build host" })
  ).toBeOnTheScreen();
  expect(screen.getByText("ABC123")).toBeOnTheScreen();
  await press("Cancel");
  await act(() =>
    pending.resolve({
      status: "ok",
      data: { id: "builder", name: "Build host", offered: [], unavailable: [] },
    })
  );
  expect(screen.getByRole("button", { name: "Scan QR" })).toBeOnTheScreen();
  expect(onPaired).not.toHaveBeenCalled();
});

test("cancels before a pairing request is sent while the phone key is preparing", async () => {
  const native = new FakeNative();
  const preparing = Promise.withResolvers<undefined>();
  native.preparePhoneKey.mockReturnValueOnce(preparing.promise);
  native.call.mockResolvedValueOnce(ok(offer()));
  const { onPaired } = await renderFlow(
    nativePairing(createNativeTransport(native))
  );
  await preview("SGP1:offer");
  await press("Confirm");
  expect(native.preparePhoneKey).toHaveBeenCalledTimes(1);
  await press("Cancel");
  await act(() => preparing.resolve(undefined));
  expect(native.call.mock.calls.map(([method]) => method)).toEqual([
    "preview_pairing",
  ]);
  expect(onPaired).not.toHaveBeenCalled();
});

test("rejects a demo code before asking the pairing adapter in a release build", async () => {
  const { pairing } = fixture();
  await renderFlow(pairing);
  const runtime = globalThis as typeof globalThis & { __DEV__: boolean };
  const dev = jest.replaceProperty(runtime, "__DEV__", false);
  try {
    await preview("SGPDEMO:approve");
    expect(
      screen.getByRole("alert", { name: "The pairing data is invalid." })
    ).toBeOnTheScreen();
    expect(pairing.previewPairing).not.toHaveBeenCalled();
  } finally {
    dev.restore();
  }
});

test("shows the keychain failure with its unlock recovery", async () => {
  const { pairing, pending } = fixture();
  await renderFlow(pairing);
  await preview("SGP1:offer");
  await press("Confirm");
  await act(() =>
    pending.reject({
      source: "native",
      kind: "keychain",
      osStatus: -25308,
      message: "The phone is locked.",
    })
  );
  expect(
    screen.getByRole("alert", { name: "Unlock this iPhone to connect" })
  ).toBeOnTheScreen();
  expect(
    screen.getByText("Unlock with your passcode, then try again.")
  ).toBeOnTheScreen();
});

test.each([
  [
    "denied",
    "The host declined the pairing request.",
    /Start pairing again on MacBook Pro/,
  ],
  ["expired", "The pairing code expired.", /Ask for a new code/],
  ["used", "The pairing code has already been used.", /Ask for a new code/],
  [
    "unknown",
    "The host does not recognize this pairing code.",
    /Start pairing again on MacBook Pro/,
  ],
  [
    "unavailable",
    "Pairing is unavailable on this host.",
    /Check StatGlass is running on MacBook Pro/,
  ],
  [
    "monitoring_off",
    "Remote monitoring is off on this host.",
    /Turn on remote monitoring on MacBook Pro/,
  ],
  ["invalid", "The pairing data is invalid.", /paste the entire pairing code/],
  [
    "host_key_unknown",
    "The host key doesn’t match the pairing code.",
    /Use a code from the host you want to add/,
  ],
  [
    "remote_unreachable",
    "StatGlass couldn’t reach the host.",
    /Check MacBook Pro is reachable on this network/,
  ],
  [
    "remote_auth",
    "The host refused the pairing key.",
    /Start pairing again on MacBook Pro/,
  ],
] as const)("shows %s with retry and exit", async (reason, title, recovery) => {
  const pairing = createMockPhonePairing();
  const { onDone } = await renderFlow(pairing);
  const text = `SGPDEMO:${reason}`;
  await preview(text);
  if (reason !== "invalid") {
    await press("Confirm");
    await act(() => pairing.tick());
  }
  expect(screen.getByRole("alert", { name: title })).toBeOnTheScreen();
  expect(screen.getByText(recovery)).toBeOnTheScreen();
  await press("Done");
  expect(onDone).toHaveBeenCalledTimes(1);
  await press("Try again");
  expect(screen.getByLabelText("Pairing code")).toBeOnTheScreen();
});

test("keeps the host's explanation separate from the pairing failure title", async () => {
  const { pairing, pending } = fixture();
  await renderFlow(pairing);
  await preview("SGP1:offer");
  await press("Confirm");
  await act(() =>
    pending.resolve({
      status: "error",
      error: {
        kind: "pairing",
        reason: "unavailable",
        message: "The agent is restarting.",
      },
    })
  );
  expect(
    screen.getByRole("alert", { name: "Pairing is unavailable on this host." })
  ).toBeOnTheScreen();
  expect(screen.getByText("The agent is restarting.")).toBeOnTheScreen();
});
