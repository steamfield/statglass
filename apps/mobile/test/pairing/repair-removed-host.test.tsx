/** Re-pairing a hidden host while the native core is already selected. */
import type {
  HostRecord,
  PairedHost,
  PairingPreview,
} from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import { expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { ExpoRoot, Stack } from "expo-router";
import {
  fireEvent,
  getMockContext,
  screen,
  waitFor,
} from "expo-router/testing-library";
import HostsLayout from "@/app/(hosts)/_layout";
import HostsRoute from "@/app/(hosts)/index";
import FirstLaunch from "@/app/index";
import PairRoute from "@/app/pair";
import PairHostsRoute from "@/app/pair-hosts";
import { PairingProvider } from "@/session/pairing";
import { CoreProvider } from "@/transport";

const REMOVED_HOST_ID = "removed-studio";
const PAIRING_CODE = "SGP1:studio";
const routes = getMockContext({
  _layout: () => <Stack />,
  index: FirstLaunch,
  "(hosts)/_layout": HostsLayout,
  "(hosts)/index": HostsRoute,
  pair: PairRoute,
  "pair-hosts": PairHostsRoute,
});

function pairingPreview(host: HostRecord): PairingPreview {
  return {
    host_id: host.id,
    name: host.display_name,
    os: host.info.os,
    user: "ci",
    targets: [{ route: "lan", host: "studio.local" }],
    code: "ABC234",
    expires_ms: Date.now() + 60_000,
    can_hand_over: true,
  };
}

/**
 * Installs a restored native core with one visible host and one hidden host.
 * @throws If the shared transport provides no host fixture.
 */
async function installRestoredCore() {
  const [fixture] = await createMockTransport({ historyRows: 2 }).listHosts();
  if (!fixture) throw new Error("Expected a host fixture");
  const existing = {
    ...fixture,
    is_local: false,
    display_name: "Existing server",
  };
  const studio = { ...existing, id: REMOVED_HOST_ID, display_name: "Studio" };
  const roster = [existing, studio];
  const offer: PairedHost = {
    id: studio.id,
    name: studio.display_name,
    offered: [],
    unavailable: [{ id: "warehouse", name: "Warehouse", reason: "proxy_jump" }],
  };
  const native = new FakeNative();
  let keyChanged = true;
  native.call.mockImplementation(async (method) => {
    switch (method) {
      case "list_hosts":
        return ok(roster);
      case "list_remote_hosts":
        return ok([]);
      case "pairing_state":
        return ok({ hosts: roster.length, key_changed: keyChanged });
      case "preview_pairing":
        return ok(pairingPreview(studio));
      case "pair":
        keyChanged = false;
        native.emit("onCoreEvent", {
          event: JSON.stringify({ kind: "hosts_changed", hosts: roster }),
        });
        return ok(offer);
      default:
        return ok(null);
    }
  });
  installNative(native);
}

async function confirmPairing() {
  await fireEvent.press(screen.getByRole("button", { name: "Pair again" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: "Paste code" })
  );
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code"),
    PAIRING_CODE
  );
  await fireEvent.press(screen.getByRole("button", { name: "Preview host" }));
  await fireEvent.press(await screen.findByRole("button", { name: "Confirm" }));
}

test("re-pairing on the selected native core restores the host and refreshes its pairing status", async () => {
  await installRestoredCore();
  const { client } = await renderWithProviders(
    <CoreProvider>
      <PairingProvider>
        <ExpoRoot context={routes} location="/(hosts)" />
      </PairingProvider>
    </CoreProvider>,
    { settings: { removed: [REMOVED_HOST_ID] } }
  );
  expect(
    await screen.findByRole("button", {
      name: /^Existing server, .*Needs pairing/,
    })
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: /^Studio,/ })).toBeNull();

  await confirmPairing();
  expect(
    await screen.findByRole("header", { name: "Also on Studio" })
  ).toBeOnTheScreen();
  // Capture the invalidation while Hosts is blurred and before it refetches on focus.
  const pairingWasInvalidated = client.getQueryState(
    hostKeys.pairing()
  )?.isInvalidated;
  await fireEvent.press(screen.getByRole("button", { name: "Skip" }));

  expect(
    await screen.findByRole("button", { name: /^Studio,/ })
  ).toBeOnTheScreen();
  expect(pairingWasInvalidated).toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Pair again" })).toBeNull()
  );
});
