import type { LiveMsg } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { phoneCommandFailures } from "@core/mock/phone-errors";
import { createMockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { ExpoRoot, Stack, usePathname } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import type { ProfilerOnRenderCallback } from "react";
import {
  type AccessibilityActionInfo,
  ActionSheetIOS,
  AppState,
  Text,
} from "react-native";
import {
  NestedReorderableList,
  type ReorderableListProps,
} from "react-native-reorderable-list";
import {
  DEFAULT_PHONE_SETTINGS,
  PhoneSettingsProvider,
} from "@/data/phone-settings";
import { HostScreen } from "@/host";

const mockCardCommit = jest.fn<ProfilerOnRenderCallback>();

jest.mock("react-native-reanimated", () => ({
  ...require("@test/ui/reanimated-list-stub").reanimatedListStub,
  runOnJS: (callback: unknown) => callback,
}));

// Render the real list and capture the events the native drag worklets deliver.
jest.mock("react-native-reorderable-list", () => {
  const list: typeof import("react-native-reorderable-list") =
    jest.requireActual("react-native-reorderable-list");
  const { Profiler } = jest.requireActual<typeof import("react")>("react");
  return {
    ...list,
    __esModule: true,
    NestedReorderableList: jest.fn((props: ReorderableListProps<unknown>) => (
      <list.NestedReorderableList
        {...props}
        renderItem={(info) => (
          <Profiler
            id={
              props.keyExtractor?.(info.item, info.index) ?? String(info.index)
            }
            onRender={mockCardCommit}
          >
            {props.renderItem?.(info)}
          </Profiler>
        )}
      />
    )),
  };
});

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "(hosts)/[host]/index": HostScreen,
  "(hosts)/[host]/[module]": function ModulePage() {
    return <Text>{usePathname()}</Text>;
  },
});

const location = new URL(`statglass:///${MOCK_HOST_ID}`);

const initialAppState = AppState.currentState;
beforeEach(() => {
  AppState.currentState = "active";
  jest.mocked(NestedReorderableList).mockClear();
});
afterEach(() => {
  AppState.currentState = initialAppState;
  jest.useRealTimers();
});

test("the host shows saved card order and density", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const view = await renderWithProviders(
    <ExpoRoot context={context} location={location} />,
    {
      transport,
      settings: {
        compact: {
          ...DEFAULT_PHONE_SETTINGS.compact,
          memory: true,
          network: true,
        },
        cardOrder: ["network", "memory", "gpu", "power", "cpu"],
      },
    }
  );
  try {
    await screen.findByRole("button", { name: /^Power & battery,/ });
    const cards = within(screen.getByLabelText("Module cards"));
    const buttons = cards.getAllByRole("button", {
      name: /^(CPU|Memory|GPU|Power|Network)([^,]*),/,
    });
    expect(buttons).toHaveLength(5);
    for (const [index, title] of [
      "Network",
      "Memory",
      "GPU",
      "Power & battery",
      "CPU",
    ].entries()) {
      expect(buttons[index]).toHaveAccessibleName(new RegExp(`^${title},`));
    }
    expect(cards.queryByText("Swap")).not.toBeOnTheScreen();
    expect(cards.queryByText("Remaining")).not.toBeOnTheScreen();
    const network = cards.getByRole("button", { name: /^Network,/ });
    expect(within(network).queryByRole("image")).not.toBeOnTheScreen();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("Linux keeps usable cards in order and explains why GPU is unavailable", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux"],
    historyRows: 2,
  });
  const view = await renderWithProviders(
    <ExpoRoot context={context} location={location} />,
    { transport }
  );
  try {
    await screen.findByText("Not available on this host");
    const cards = within(screen.getByLabelText("Module cards"));
    const buttons = cards.getAllByRole("button", {
      name: /^(CPU|Memory|Power|Network)([^,]*),/,
    });
    expect(buttons).toHaveLength(4);
    for (const [index, title] of [
      "CPU",
      "Memory",
      "Power",
      "Network",
    ].entries()) {
      expect(buttons[index]).toHaveAccessibleName(new RegExp(`^${title},`));
    }
    expect(
      cards.queryByRole("button", { name: /^GPU,/ })
    ).not.toBeOnTheScreen();
    expect(cards.queryByText("Battery")).not.toBeOnTheScreen();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("renders a standalone Battery and explains the edition-blocked GPU", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const capabilities = await transport.getCapabilities(MOCK_HOST_ID);
  if (capabilities.status !== "ok")
    throw new Error("Expected demo capabilities");
  const view = await renderWithProviders(
    <ExpoRoot context={context} location={location} />,
    { transport }
  );
  try {
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    await act(() =>
      transport.push({
        kind: "caps",
        capabilities: {
          ...capabilities.data,
          revision: capabilities.data.revision + 1,
          modules: {
            ...capabilities.data.modules,
            power: "not_present",
            gpu: { unsupported: "missing_entitlement" },
          },
        },
      })
    );
    expect(
      await screen.findByRole("button", { name: /^Battery,/ })
    ).toBeOnTheScreen();
    expect(screen.getByText("Not available in this edition")).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: /^(GPU|Power),/ })
    ).not.toBeOnTheScreen();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

function storageFixture() {
  let saved: string | null = null;
  return {
    read: () => saved,
    write: (text: string) => {
      saved = text;
    },
  };
}

async function openCards({
  host = MOCK_HOST_ID,
  storage = storageFixture(),
  transport = createMockTransport({ autoTick: false, historyRows: 2 }),
} = {}) {
  const view = await renderWithProviders(
    <PhoneSettingsProvider storage={storage}>
      <ExpoRoot context={context} location={new URL(`statglass:///${host}`)} />
    </PhoneSettingsProvider>,
    { transport, settings: {} }
  );
  await screen.findByRole("button", { name: /^CPU,/ });
  return view;
}

function dragCallbacks() {
  const props = jest.mocked(NestedReorderableList).mock.lastCall?.[0];
  if (!props?.onDragStart || !props.onDragEnd)
    throw new Error("Expected a nested drag list");
  return {
    onDragStart: props.onDragStart,
    onDragEnd: props.onDragEnd,
    onReorder: props.onReorder,
  };
}

const cpuButton = () => screen.getByRole("button", { name: /^CPU,/ });
// The touch controls and their text sit inside the grouped VoiceOver card.
const cardContents = { includeHiddenElements: true };

function visibleCardTitles() {
  return within(screen.getByLabelText("Module cards"))
    .getAllByRole("button", {
      name: /^(CPU|Memory|GPU|Power|Network|Battery)([^,]*),/,
    })
    .map(({ props }) => String(props.accessibilityLabel).split(",")[0]);
}

test("the density chevron plays a light haptic and saves density across a remount", async () => {
  jest.useFakeTimers();
  const storage = storageFixture();
  const impact = jest
    .spyOn(Haptics, "impactAsync")
    .mockResolvedValue(undefined);
  const view = await openCards({ storage });
  expect(within(cpuButton()).getByText("User", cardContents)).toBeOnTheScreen();
  const chevron = screen.getByLabelText("Compact CPU card", cardContents);
  await fireEvent.press(chevron);
  expect(impact.mock.calls).toEqual([[Haptics.ImpactFeedbackStyle.Light]]);
  expect(
    screen.getByLabelText("Expand CPU card", cardContents)
  ).toBeOnTheScreen();
  expect(within(cpuButton()).queryByText("User", cardContents)).toBeNull();
  await act(() => jest.advanceTimersByTimeAsync(500));
  await view.unmount();
  await openCards({ storage });
  expect(
    screen.getByLabelText("Expand CPU card", cardContents)
  ).toBeOnTheScreen();
  expect(within(cpuButton()).queryByText("User", cardContents)).toBeNull();
});

test("the card body opens the selected module", async () => {
  await openCards();
  await fireEvent.press(within(cpuButton()).getByText("CPU", cardContents));
  expect(await screen.findByText(`/${MOCK_HOST_ID}/cpu`)).toBeOnTheScreen();
});

test("a hold and drag saves the new order for a different host after remount", async () => {
  jest.useFakeTimers();
  const storage = storageFixture();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const remote = (await transport.listHosts()).find(
    ({ info }) => info.os === "linux"
  );
  if (!remote) throw new Error("Expected a Linux host");
  // On relaunch the test only needs the other host to read the stored order.
  jest.spyOn(transport, "listHosts").mockResolvedValue([remote]);
  const sheet = jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => {});
  const view = await openCards({ storage });
  expect(visibleCardTitles().slice(0, 2)).toEqual(["CPU", "Memory"]);
  const drag = dragCallbacks();
  await act(() => drag.onDragStart({ index: 0 }));
  await act(() => drag.onDragEnd({ from: 0, to: 1, cancelled: false }));
  await act(() => drag.onReorder({ from: 0, to: 1 }));
  expect(visibleCardTitles().slice(0, 2)).toEqual(["Memory", "CPU"]);
  expect(sheet).not.toHaveBeenCalled();
  await act(() => jest.advanceTimersByTimeAsync(500));
  await view.unmount();
  await openCards({ host: remote.id, storage, transport });
  expect(visibleCardTitles().slice(0, 2)).toEqual(["Memory", "CPU"]);
});

test("releasing a hold without moving shows the native menu and applies each choice", async () => {
  const sheet = jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => {});
  await openCards();
  async function release(index: number, density: string, select: number) {
    const drag = dragCallbacks();
    await act(() => drag.onDragStart({ index }));
    expect(sheet).not.toHaveBeenCalled();
    await act(() =>
      drag.onDragEnd({ from: index, to: index, cancelled: false })
    );
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.lastCall?.[0]).toEqual({
      options: [density, "Open Memory", "Move to top", "Cancel"],
      cancelButtonIndex: 3,
    });
    const choose = sheet.mock.lastCall?.[1];
    if (!choose) throw new Error("Expected an action sheet");
    await act(() => choose(select));
    sheet.mockClear();
  }
  await release(1, "Compact", 0);
  expect(
    screen.getByLabelText("Expand Memory card", cardContents)
  ).toBeOnTheScreen();
  expect(screen.queryByText("Swap", cardContents)).not.toBeOnTheScreen();
  await release(1, "Expand", 0);
  expect(
    screen.getByLabelText("Compact Memory card", cardContents)
  ).toBeOnTheScreen();
  expect(screen.getByText("Swap", cardContents)).toBeOnTheScreen();
  await release(1, "Compact", 2);
  expect(visibleCardTitles().slice(0, 2)).toEqual(["Memory", "CPU"]);
  await release(0, "Compact", 3);
  expect(visibleCardTitles().slice(0, 2)).toEqual(["Memory", "CPU"]);
  expect(screen.getByText("Swap", cardContents)).toBeOnTheScreen();
  await release(0, "Compact", 1);
  expect(await screen.findByText(`/${MOCK_HOST_ID}/memory`)).toBeOnTheScreen();
});

test("one VoiceOver target per card can change density, open and reorder", async () => {
  await openCards();
  const memoryButton = () => screen.getByRole("button", { name: /^Memory,/ });
  const actions: AccessibilityActionInfo[] =
    memoryButton().props.accessibilityActions;
  expect(actions.map(({ label }) => label)).toEqual([
    "Toggle compact",
    "Open",
    "Move up",
    "Move down",
    "Move to top",
  ]);
  expect(within(memoryButton()).queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryByLabelText("Compact Memory card")).toBeNull();

  async function perform(node: ReturnType<typeof cpuButton>, label: string) {
    const accessibilityActions: AccessibilityActionInfo[] =
      node.props.accessibilityActions;
    const action = accessibilityActions.find(
      (action) => action.label === label
    );
    if (!action) throw new Error(`Missing ${label} on card`);
    await fireEvent(node, "accessibilityAction", {
      nativeEvent: { actionName: action.name },
    });
  }
  await perform(cpuButton(), "Move down");
  expect(visibleCardTitles().slice(0, 2)).toEqual(["Memory", "CPU"]);
  await perform(cpuButton(), "Move up");
  expect(visibleCardTitles().slice(0, 2)).toEqual(["CPU", "Memory"]);
  await perform(memoryButton(), "Move to top");
  expect(visibleCardTitles().slice(0, 2)).toEqual(["Memory", "CPU"]);
  await perform(cpuButton(), "Toggle compact");
  expect(
    screen.getByLabelText("Expand CPU card", cardContents)
  ).toBeOnTheScreen();
  expect(within(cpuButton()).queryByText("User", cardContents)).toBeNull();
  await perform(cpuButton(), "Open");
  expect(await screen.findByText(`/${MOCK_HOST_ID}/cpu`)).toBeOnTheScreen();
});

test("a frame with only a changed CPU reading commits only the CPU card", async () => {
  mockCardCommit.mockClear();
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = transport.subscribeLive;
  const messages: LiveMsg[] = [];
  jest
    .spyOn(transport, "subscribeLive")
    .mockImplementation((host, receive, options) =>
      subscribe(
        host,
        (message) => {
          messages.push(message);
          receive(message);
        },
        options
      )
    );
  await openCards({ transport });
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
  const frame = messages.find((message) => message.kind === "frame");
  const layout = messages.find(
    (message) =>
      message.kind === "layout" && message.layout_no === frame?.layout_no
  );
  if (!frame || layout?.kind !== "layout")
    throw new Error("Expected a live frame and layout");
  const cpu = layout.series.findIndex(({ metric }) => metric === "cpu.total");
  if (cpu < 0) throw new Error("Expected CPU in the live layout");
  expect(mockCardCommit.mock.calls.map(([id]) => id)).toEqual(
    expect.arrayContaining(["cpu", "memory", "gpu", "power", "network"])
  );
  const before = cpuButton().props.accessibilityLabel;
  mockCardCommit.mockClear();
  await act(() =>
    transport.push({
      ...frame,
      held: frame.held.map((value, index) =>
        index === cpu ? (value ?? 0) + 2 : value
      ),
    })
  );
  expect(cpuButton().props.accessibilityLabel).not.toBe(before);
  expect(mockCardCommit.mock.calls.map(([id]) => id)).toEqual(["cpu"]);
});

test("before the first frame the cards keep their loaded shape", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  // The subscription never answers, so no layout or frame arrives.
  jest
    .spyOn(transport, "subscribeLive")
    .mockImplementation(() => new Promise(() => {}));
  const view = await openCards({ transport });
  try {
    const cards = within(screen.getByLabelText("Module cards"));
    for (const name of [/^CPU,/, /^GPU,/, /^Network,/]) {
      const chart = within(cards.getByRole("button", { name })).getByRole(
        "image",
        cardContents
      );
      expect(chart).toHaveProp("accessibilityState", { busy: true });
    }
    expect(
      cards.queryByText("No power readings", cardContents)
    ).not.toBeOnTheScreen();
    const memory = cards.getByRole("button", { name: /^Memory,/ });
    for (const row of ["Pressure", "Wired", "App"])
      expect(within(memory).getByText(row, cardContents)).toBeOnTheScreen();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

function cardChart(name: RegExp) {
  const cards = within(screen.getByLabelText("Module cards"));
  return within(cards.getByRole("button", { name })).getByRole(
    "image",
    cardContents
  );
}

test("a failed first subscribe draws still charts and says Power has no readings", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  transport.failNext("subscribeLive", phoneCommandFailures.revokedKey);
  jest.spyOn(console, "error").mockImplementation(() => {});
  const view = await openCards({ transport });
  try {
    await waitFor(() =>
      expect(cardChart(/^CPU,/)).toHaveProp("accessibilityState", {
        busy: false,
      })
    );
    const cards = within(screen.getByLabelText("Module cards"));
    expect(
      cards.getByText("No power readings", cardContents)
    ).toBeOnTheScreen();
    const memory = cards.getByRole("button", { name: /^Memory,/ });
    expect(within(memory).queryByText("Wired", cardContents)).toBeNull();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("a paused host that sends no frames draws still charts", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const subscribe = transport.subscribeLive;
  // Paused longer than the backfill window: the subscribe reports no rows, and
  // only the layout and a paused status arrive.
  const sends = new Set<LiveMsg["kind"]>(["caps", "layout", "holds"]);
  jest
    .spyOn(transport, "subscribeLive")
    .mockImplementation(async (host, receive, options) => {
      const subscription = await subscribe(
        host,
        (message) => {
          if (message.kind === "status") receive({ ...message, paused: true });
          else if (sends.has(message.kind)) receive(message);
        },
        options
      );
      const { info } = subscription;
      if (info.status !== "ok") return subscription;
      return {
        ...subscription,
        info: {
          status: "ok",
          data: { ...info.data, backfill_rows: 0, earlier_start_ms: null },
        },
      };
    });
  const view = await openCards({ transport });
  try {
    await waitFor(() => expect(transport.subscriberCount()).toBe(1));
    await act(() =>
      transport.push({
        kind: "status",
        interval_ms: 1000,
        frame_period_ms: 1000,
        paused: true,
        display_idle: false,
        on_battery: false,
        performance: "off",
        power_source: "adapter",
        primary_iface: null,
      })
    );
    for (const name of [/^CPU,/, /^GPU,/, /^Network,/])
      await waitFor(() =>
        expect(cardChart(name)).toHaveProp("accessibilityState", {
          busy: false,
        })
      );
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("retrying a failed subscribe keeps the cards' failed shape", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  transport.failNext("subscribeLive", {
    kind: "internal",
    message: "Live updates stopped.",
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  const subscribe = transport.subscribeLive;
  // The retry stays in flight.
  const calls = jest
    .spyOn(transport, "subscribeLive")
    .mockImplementationOnce((...args) => subscribe(...args))
    .mockImplementation(() => new Promise(() => {}));
  const view = await openCards({ transport });
  try {
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    expect(cardChart(/^CPU,/)).toHaveProp("accessibilityState", {
      busy: false,
    });
    const cards = within(screen.getByLabelText("Module cards"));
    expect(
      cards.getByText("No power readings", cardContents)
    ).toBeOnTheScreen();
  } finally {
    await view.unmount();
    transport.dispose();
  }
});
