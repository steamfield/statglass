import type {
  HostRecord,
  OfferedHost,
  PairedHost,
  PairingPreview,
} from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useRouter } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import { PairingProvider } from "@/data/pairing-context";
import { PairSelection } from "@/handover/pair-selection";
import { PairingFlow } from "@/pairing";
import { afterPair } from "@/pairing/after-pair";
import { createNativeTransport, nativePairing } from "@/transport";
import { Button } from "@/ui/button";
import { Text } from "@/ui/text";

function offered(id: string, name: string): OfferedHost {
  return {
    id,
    name,
    os: "Linux",
    user: "ci",
    port: null,
    targets: [{ route: "lan", host: `${id}.local` }],
    host_keys: [{ algorithm: "ssh-ed25519", sha256: "SHA256:pin" }],
  };
}

const first = offered("build", "Build server");
const second = offered("files", "File server");
const offer: PairedHost = {
  id: "studio",
  name: "Studio",
  offered: [first, second],
  unavailable: [{ id: "jump", name: "Warehouse", reason: "proxy_command" }],
};

test("finishes approval through the real chooser and retries a failed Add", async () => {
  const native = new FakeNative();
  const [example] = await createMockTransport().listHosts();
  if (!example) throw new Error("Expected a host fixture");
  let roster: HostRecord[] = [];
  let fail = true;
  native.call.mockImplementation(async (method, args) => {
    switch (method) {
      case "list_hosts":
        return ok(roster);
      case "list_remote_hosts":
        return ok([]);
      case "preview_pairing":
        return ok({
          host_id: offer.id,
          name: offer.name,
          os: "Linux",
          user: "ci",
          targets: [{ route: "lan", host: "studio.local" }],
          code: "ABC234",
          expires_ms: Date.now() + 60_000,
          can_hand_over: true,
        } satisfies PairingPreview);
      case "pair":
        roster = [{ ...example, id: offer.id, display_name: offer.name }];
        return ok(offer);
      case "add_handover_hosts":
        if (fail) {
          fail = false;
          return JSON.stringify({
            status: "error",
            error: { kind: "store", message: "Couldn’t save the hosts." },
          });
        }
        roster = roster.concat(
          (JSON.parse(args) as { hosts: OfferedHost[] }).hosts.map((host) => ({
            ...example,
            id: host.id,
            display_name: host.name,
          }))
        );
        return ok(null);
      default:
        return ok(null);
    }
  });
  installNative(native);
  const router = await renderRouter("./src/app", { initialUrl: "/pair" });
  await fireEvent.press(
    await screen.findByRole("button", { name: "Paste code" })
  );
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code"),
    "SGP1:pair"
  );
  await press("Preview host");
  await fireEvent.press(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByRole("header", { name: "Also on Studio" })
  ).toBeOnTheScreen();
  expect(router.getPathname()).toBe("/pair-hosts");
  await fireEvent.press(screen.getByRole("checkbox", { name: "File server" }));
  await press("Add");
  expect(
    await screen.findByRole("alert", { name: "Couldn’t save the hosts." })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("checkbox", { name: "File server", checked: false })
  ).toBeOnTheScreen();
  await press("Add");
  expect(
    await screen.findByRole("button", { name: /^Build server,/ })
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: /^File server,/ })).toBeNull();
});

async function showPair(hosts = offer.offered) {
  const native = new FakeNative();
  const [example] = await createMockTransport().listHosts();
  if (!example) throw new Error("Expected a host fixture");
  let roster: HostRecord[] = [
    { ...example, id: offer.id, display_name: offer.name },
  ];
  native.call.mockImplementation(async (method, args) => {
    if (method === "list_hosts") return ok(roster);
    if (method === "add_handover_hosts") {
      roster = roster.concat(
        (JSON.parse(args) as { hosts: OfferedHost[] }).hosts.map((host) => ({
          ...example,
          id: host.id,
          display_name: host.name,
        }))
      );
    }
    return ok(null);
  });
  const core = createNativeTransport(native);
  const done = jest.fn();
  await renderWithProviders(
    <PairSelection
      core={core}
      offer={{ ...offer, offered: hosts }}
      done={done}
    />,
    { transport: core }
  );
  return { core, done };
}

const press = (name: string) =>
  fireEvent.press(screen.getByRole("button", { name }));

test("shows the pairing offer with all hosts checked and adds only the checked hosts", async () => {
  const { core, done } = await showPair();
  expect(
    screen.getByRole("header", { name: "Also on Studio" })
  ).toBeOnTheScreen();
  expect(
    screen.getByText("Also add the 2 hosts this Mac monitors.")
  ).toBeOnTheScreen();
  expect(screen.getByText("SSH uses a proxy command.")).toBeOnTheScreen();
  expect(
    screen.getByRole("checkbox", { name: "Build server", checked: true })
  ).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("checkbox", { name: "File server", checked: true })
  );
  expect((await core.listHosts()).map((host) => host.id)).toEqual(["studio"]);
  await press("Add");
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect((await core.listHosts()).map((host) => host.id)).toEqual([
    "studio",
    "build",
  ]);
});

test.each([true, false])(
  "Skip adds no hosts with selectable hosts %s",
  async (selectable) => {
    const { core, done } = await showPair(selectable ? [first] : []);
    expect(screen.getByText("Warehouse")).toBeOnTheScreen();
    if (!selectable)
      expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    await press("Skip");
    expect(done).toHaveBeenCalledTimes(1);
    expect((await core.listHosts()).map((host) => host.id)).toEqual(["studio"]);
  }
);

test("asks for a pairing code when an update code is pasted into Add a host", async () => {
  const pairing = nativePairing(createNativeTransport(new FakeNative()));
  await renderWithProviders(
    <PairingProvider pairing={pairing}>
      <PairingFlow onPaired={jest.fn()} onDone={jest.fn()} />
    </PairingProvider>
  );
  await press("Paste code");
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code"),
    "SGB1:update"
  );
  await press("Preview host");
  expect(
    screen.getByRole("alert", { name: "The pairing data is invalid." })
  ).toBeOnTheScreen();
  expect(
    screen.getByText("Scan the QR again or paste the entire pairing code.")
  ).toBeOnTheScreen();
});

test.each([
  ["offer", offer, "/pair-hosts"],
  ["unavailable only", { ...offer, offered: [] }, "/pair-hosts"],
  ["neither list", { ...offer, offered: [], unavailable: [] }, "/"],
] satisfies [string, PairedHost, string][])(
  "routes after approval with %s",
  async (_, result, route) => {
    function Pair() {
      const router = useRouter();
      return (
        <Button
          label="Finish pairing"
          onPress={() => afterPair(router, result)}
        />
      );
    }
    function Destination() {
      return <Text variant="body">Destination</Text>;
    }
    const router = await renderRouter(
      {
        pair: Pair,
        "pair-hosts": Destination,
        "(hosts)/index": Destination,
      },
      { initialUrl: "/pair" }
    );
    await press("Finish pairing");
    expect(router.getPathname()).toBe(route);
  }
);
