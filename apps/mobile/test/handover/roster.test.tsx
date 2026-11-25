import type { MobileRemoteHost } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { phoneProblem } from "@core/phone-connection";
import { expect, test } from "@jest/globals";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { Slot } from "expo-router";
import { fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { ProblemBanner } from "@/connection/problem-banner";
import { AppProviders } from "@/lib/providers";
import { createNativeTransport, toRemoteHostRecord } from "@/transport";
import { Text } from "@/ui/text";

const handedOver: MobileRemoteHost = {
  id: "build",
  name: "Build server",
  os: "linux",
  targets: [{ route: "lan", host: "build.local" }],
  source_mac: "studio",
  removed_by_controller: true,
  connection: {
    state: "error",
    route: null,
    sync: "idle",
    failure: "authentication",
    incompatible_side: null,
    message: "key refused",
    route_failures: [],
  },
  open_error: null,
  demand: null,
  last_seen_ms: null,
  synced_through_ms: null,
  next_attempt_ms: null,
  attempt: 0,
  dialing: false,
  waiting_for_network: false,
  clock_offset_ms: null,
  vitals: {
    as_of_ms: null,
    cpu_pct: null,
    memory_pct: null,
    load_1m: null,
    cores: null,
    memory_pressure: null,
    disk_used_bytes: null,
    disk_free_bytes: null,
    disk_total_bytes: null,
    disk_low: false,
    net_rx_bps: null,
    net_tx_bps: null,
  },
  agent_version: null,
  identity_changed: null,
};

test("Settings shows the applied Mac removal mark and keeps the normal Remove action", async () => {
  const native = new FakeNative();
  const [example] = await createMockTransport().listHosts();
  if (!example) throw new Error("Expected a host fixture");
  let removed = false;
  native.call.mockImplementation(async (method) => {
    switch (method) {
      case "list_hosts":
        return ok(
          removed
            ? []
            : [{ ...example, id: handedOver.id, display_name: handedOver.name }]
        );
      case "list_remote_hosts":
        return ok(removed ? [] : [handedOver]);
      case "remove_host":
        removed = true;
        return ok(null);
      default:
        return ok(null);
    }
  });
  installNative(native);
  await renderRouter("./src/app", { initialUrl: "/settings/hosts" });
  expect(await screen.findByText("Removed on your Mac")).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Remove Build server" })
  );
  await fireEvent.press(
    await screen.findByRole("button", { name: "Remove host" })
  );
  expect(await screen.findByText("No hosts on this iPhone.")).toBeOnTheScreen();
});

test("a first SSH refusal offers Retry as well as Re-pair for a handed-over host", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  let connected = false;
  native.call.mockImplementation(async (method) => {
    if (method === "retry_remote_host") connected = true;
    return ok(null);
  });
  function Layout() {
    return (
      <AppProviders initialTransport={{ transport, demo: false }}>
        <Slot />
      </AppProviders>
    );
  }
  function Host() {
    const problem = phoneProblem(toRemoteHostRecord(handedOver));
    return problem && <ProblemBanner host={handedOver.id} problem={problem} />;
  }
  await renderRouter({
    _layout: Layout,
    index: Host,
    pair: () => <Text variant="body">Pair again</Text>,
  });
  expect(await screen.findByText("Key not accepted by sshd")).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Re-pair" })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(connected).toBe(true);
});
