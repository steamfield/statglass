import {
  selectBattery,
  selectCpu,
  selectGpu,
  selectMemory,
  selectNetwork,
  selectPower,
  selectPowerSource,
} from "@core/live-selectors";
import { initialHostLive, reduceLive } from "@core/live-state";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import {
  POPOVER_CPU_STREAM,
  POPOVER_GPU_STREAM,
} from "@core/widget-models/fixtures/charts";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import {
  DEFAULT_PHONE_SETTINGS,
  usePhoneSettings,
} from "@/data/phone-settings";
import { CardMenu } from "@/host/card-menu";
import {
  buildCardStack,
  cardActions,
  cardModuleStates,
  moveCard,
} from "@/host/card-stack";

async function demoSelections(host = MOCK_HOST_ID) {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["hosts-dashboard"],
    historyRows: 2,
  });
  let state = initialHostLive(host);
  const subscription = await transport.subscribeLive(host, (message) => {
    state = reduceLive(state, message);
  });
  subscription.unsubscribe();
  const record = (await transport.listHosts()).find(({ id }) => id === host);
  const bars = {
    accent: "net",
    up: [1],
    down: [null],
    upMax: 100,
    downMax: 100,
    intervalMs: 1000,
    ariaLabel: "Network upload and download",
  } as const;
  return {
    states: cardModuleStates(state.capabilities),
    data: {
      cpu: { cpu: selectCpu(state), stream: POPOVER_CPU_STREAM },
      memory: {
        memory: selectMemory(state),
        totalBytes: record?.info.mem_total_bytes ?? null,
      },
      gpu: { gpu: selectGpu(state), stream: POPOVER_GPU_STREAM },
      power: { power: selectPower(state), source: selectPowerSource(state) },
      network: { network: selectNetwork(state), bars },
      battery: {
        battery: selectBattery(state),
        source: selectPowerSource(state),
      },
    },
  };
}

test("assembles each card's own selection, chart, actions and saved density in phone order", async () => {
  const { states, data } = await demoSelections();
  const open = jest.fn();
  const menu = jest.fn();
  const actions = cardActions(open, menu);
  const settings = {
    ...DEFAULT_PHONE_SETTINGS,
    compact: { ...DEFAULT_PHONE_SETTINGS.compact, memory: true, network: true },
    cardOrder: moveCard(null, "network", "cpu"),
  };
  const slots = buildCardStack(
    {
      ...states,
      cpu: "on",
      memory: "on",
      gpu: "on",
      power: "on",
      network: "on",
      battery: "on",
    },
    settings,
    data,
    actions
  );
  expect(slots.map(({ kind }) => kind)).toEqual([
    "network",
    "memory",
    "gpu",
    "power",
    "cpu",
  ]);
  for (const slot of slots) {
    if (slot.kind === "unavailable") throw new Error("Expected usable cards");
    expect(slot.props).toEqual({
      ...data[slot.kind],
      ...(slot.kind === "power" && { battery: data.battery.battery }),
      compact: settings.compact[slot.kind],
      onOpen: expect.any(Function),
      onLongPress: expect.any(Function),
    });
    slot.props.onOpen();
    slot.props.onLongPress();
  }
  expect(open.mock.calls).toEqual([
    ["network"],
    ["memory"],
    ["gpu"],
    ["power"],
    ["cpu"],
  ]);
  expect(menu.mock.calls).toEqual(open.mock.calls);

  const onBattery = buildCardStack(
    { ...states, power: "absent", battery: "on" },
    DEFAULT_PHONE_SETTINGS,
    data,
    actions
  ).at(-1);
  expect(onBattery).toEqual({
    kind: "battery",
    props: {
      ...data.battery,
      source: data.power.source,
      compact: false,
      onOpen: expect.any(Function),
      onLongPress: expect.any(Function),
    },
  });
});

test("keeps Linux capability order and renders one unavailable slot when a capability cannot run", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["hosts-dashboard"],
  });
  const linux = (await transport.listHosts()).find(
    (host) => host.info.os === "linux"
  );
  if (!linux) throw new Error("The demo needs a Linux host");
  const { states, data } = await demoSelections(linux.id);
  const actions = cardActions(
    () => {},
    () => {}
  );
  const slots = buildCardStack(states, DEFAULT_PHONE_SETTINGS, data, actions);
  expect(slots.map(({ kind }) => kind)).toEqual([
    "cpu",
    "memory",
    "unavailable",
    "power",
    "network",
  ]);
  const unavailable = buildCardStack(
    { ...states, gpu: "edition" },
    DEFAULT_PHONE_SETTINGS,
    data,
    actions
  );
  expect(unavailable.map(({ kind }) => kind)).toEqual([
    "cpu",
    "memory",
    "unavailable",
    "power",
    "network",
  ]);
  expect(unavailable[2]).toEqual({
    kind: "unavailable",
    props: { module: "gpu", state: "edition" },
  });
  expect(slots.find(({ kind }) => kind === "power")?.props).toMatchObject({
    battery: null,
  });
});

function MenuHarness() {
  const [open, setOpen] = useState(false);
  const first = usePhoneSettings((state) => state.cardOrder?.[0] ?? "cpu");
  const moved = first !== "cpu";
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="CPU card options"
        onPress={() => setOpen(true)}
      >
        <Text>CPU card options</Text>
      </Pressable>
      {open && (
        <CardMenu
          card="cpu"
          previous={moved ? "memory" : undefined}
          next={moved ? "gpu" : "memory"}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

test("the menu saves compact and order preferences across reopening", async () => {
  await renderWithProviders(<MenuHarness />);
  const open = () =>
    fireEvent.press(screen.getByRole("button", { name: "CPU card options" }));
  await open();
  expect(screen.getByRole("header", { name: "CPU card" })).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
  await fireEvent.press(
    screen.getByRole("button", { name: "Use compact card" })
  );
  expect(
    screen.queryByRole("header", { name: "CPU card" })
  ).not.toBeOnTheScreen();
  await open();
  expect(
    screen.getByRole("button", { name: "Use expanded card" })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Move down" }));
  await open();
  expect(screen.getByRole("button", { name: "Move up" })).toBeEnabled();
  await fireEvent.press(screen.getByRole("button", { name: "Done" }));
  expect(
    screen.queryByRole("header", { name: "CPU card" })
  ).not.toBeOnTheScreen();
});
