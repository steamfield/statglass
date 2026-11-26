import "react-native-gesture-handler/jestSetup";
import type { HostRecord, MobileEvent } from "@core/generated/types";
import { hostRecord, scenarioFlags } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, ok } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { ExpoRoot, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { ActionSheetIOS, Alert } from "react-native";
import {
  NestedReorderableList,
  type ReorderableListProps,
} from "react-native-reorderable-list";
import HostDetail from "@/app/settings/host/[host]";
import Hosts from "@/app/settings/hosts";
import Settings from "@/app/settings/index";
import {
  PhoneSettingsProvider,
  type PhoneSettingsStorage,
} from "@/data/phone-settings";
import { createNativeTransport } from "@/transport";
import { Text } from "@/ui/text";

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

jest.mock("react-native-reanimated", () => ({
  ...require("@test/ui/reanimated-list-stub").reanimatedListStub,
  runOnJS: (callback: unknown) => callback,
  runOnUI:
    <Args extends unknown[]>(callback: (...args: Args) => void) =>
    (...args: Args) => {
      setTimeout(() => callback(...args), 0);
    },
  withSpring: (target: number) => target,
}));

// The real list renders the rows. Deliver the callbacks normally sent by iOS worklets.
jest.mock("react-native-reorderable-list", () => {
  const list = jest.requireActual<
    typeof import("react-native-reorderable-list")
  >("react-native-reorderable-list");
  return {
    ...list,
    __esModule: true,
    NestedReorderableList: jest.fn((props: ReorderableListProps<unknown>) => (
      <list.NestedReorderableList {...props} />
    )),
  };
});

const routes = getMockContext({
  _layout: () => <Stack />,
  index: () => <Text variant="title">First launch</Text>,
  "settings/index": Settings,
  "settings/hosts": Hosts,
  "settings/host/[host]": HostDetail,
  pair: () => <Text variant="title">Pair destination</Text>,
  "update-from-mac": () => <Text variant="title">Update destination</Text>,
});

const mockHosts = () =>
  createMockTransport({ scenarios: ["host-unreachable"] });
const hostRow = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name},`) });
const orderedNames = () =>
  screen
    .getAllByRole("button", { name: /,/ })
    .map((row) => row.props.accessibilityLabel.split(", ")[0]);
const showMenu = () =>
  jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => undefined);
const voiceAction = (row: ReturnType<typeof hostRow>, actionName: string) =>
  fireEvent(row, "accessibilityAction", { nativeEvent: { actionName } });

async function selectAction(menu: ReturnType<typeof showMenu>, index: number) {
  const last = menu.mock.lastCall;
  if (!last) throw new Error("Expected the removal action sheet");
  await act(() => last[1](index));
}

async function renderNativeHosts(location = "/settings/hosts") {
  const native = new FakeNative();
  const primary = hostRecord(scenarioFlags([]), Date.now());
  const backup = { ...primary, id: "backup", display_name: "Backup server" };
  let records = [primary, backup];
  const remove = jest.fn<(host: string) => string | Promise<string>>((host) => {
    records = records.filter(({ id }) => id !== host);
    return ok(null);
  });
  native.call.mockImplementation(async (method, args) => {
    if (method === "list_hosts") return ok(records);
    if (method === "list_remote_hosts") return ok([]);
    if (method === "remove_host") {
      const { host } = JSON.parse(args) as { host: string };
      return remove(host);
    }
    return ok(null);
  });
  await renderWithProviders(<ExpoRoot context={routes} location={location} />, {
    transport: createNativeTransport(native),
  });
  const changeRoster = (next: HostRecord[]) => {
    records = next;
    return act(() =>
      native.emit("onCoreEvent", {
        event: JSON.stringify({
          kind: "hosts_changed",
          hosts: records,
        } satisfies MobileEvent),
      })
    );
  };
  return { primary, backup, remove, changeRoster };
}

test("opens the host detail from its name and shared connection status", async () => {
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings/hosts" />,
    { transport: mockHosts() }
  );
  await fireEvent.press(
    await screen.findByRole("button", {
      name: /^unreachable, Needs attention · Host unreachable/,
    })
  );
  expect(screen.getByDisplayValue("unreachable")).toBeOnTheScreen();
  expect(screen.getByLabelText("LAN")).toHaveAccessibilityValue({
    text: "unreachable.local",
  });
});

test("redirects a direct Hosts settings link without a transport", async () => {
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings/hosts" />
  );
  expect(
    await screen.findByRole("header", { name: "First launch" })
  ).toBeOnTheScreen();
});

test("keeps the host when the VoiceOver Remove confirmation is canceled", async () => {
  const { remove } = await renderNativeHosts();
  const menu = showMenu();
  const row = await screen.findByRole("button", { name: /^MacBook Pro,/ });
  await voiceAction(row, "remove");
  expect(menu).toHaveBeenLastCalledWith(
    {
      options: ["Remove MacBook Pro", "Cancel"],
      message:
        "This iPhone stops monitoring MacBook Pro. Its history stays on the host.",
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    },
    expect.any(Function)
  );
  await selectAction(menu, 1);
  expect(remove).not.toHaveBeenCalled();
  expect(row).toBeOnTheScreen();
});

test("shows a typed removal failure and drops the host on a confirmed retry", async () => {
  const { primary, backup, remove, changeRoster } = await renderNativeHosts();
  const menu = showMenu();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  remove.mockReturnValueOnce(
    JSON.stringify({
      status: "error",
      error: { kind: "internal", message: "Host removal is busy." },
    })
  );
  await fireEvent.press(
    await screen.findByRole("button", { name: /^MacBook Pro,/ })
  );
  await fireEvent.changeText(
    screen.getByLabelText("Name on this iPhone"),
    "Build laptop"
  );
  await fireEvent(
    screen.getByLabelText("Name on this iPhone"),
    "submitEditing"
  );
  await act(() => router.back());
  await voiceAction(screen.getByLabelText("Reorder Build laptop"), "moveDown");

  await voiceAction(hostRow("Build laptop"), "remove");
  await selectAction(menu, 0);
  expect(alert).toHaveBeenCalledWith(
    "Couldn’t remove Build laptop",
    "Host removal is busy."
  );
  expect(hostRow("Build laptop")).toBeOnTheScreen();

  await voiceAction(hostRow("Build laptop"), "remove");
  await selectAction(menu, 0);
  expect(remove.mock.calls).toEqual([[primary.id], [primary.id]]);
  expect(screen.queryByRole("button", { name: /^Build laptop,/ })).toBeNull();

  const newcomer = { ...backup, id: "new", display_name: "New server" };
  await changeRoster([newcomer, primary, backup]);
  await screen.findByRole("button", { name: /^New server,/ });
  expect(orderedNames()).toEqual([
    "Backup server",
    "New server",
    "MacBook Pro",
  ]);
});

test("shares the pending removal between the roster and host detail", async () => {
  const { remove, primary } = await renderNativeHosts();
  const pending = Promise.withResolvers<string>();
  remove.mockReturnValueOnce(pending.promise);
  const menu = showMenu();
  const row = await screen.findByRole("button", { name: /^MacBook Pro,/ });
  await voiceAction(row, "remove");
  await selectAction(menu, 0);
  await fireEvent.press(row);
  await fireEvent.press(await screen.findByRole("button", { name: "Remove" }));
  expect(menu).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls).toEqual([[primary.id]]);
  await act(() => pending.resolve(ok(null)));
});

test("explains a failed status read and retries the status query", async () => {
  const transport = mockHosts();
  transport.failNext("listRemoteHosts", {
    kind: "store",
    message: "The status service is busy.",
  });
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings/hosts" />,
    { transport }
  );
  expect(
    await screen.findByText("The status service is busy.")
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", {
      name: /^unreachable, Needs attention · Host unreachable/,
    })
  ).toBeOnTheScreen();
  expect(screen.queryByText("The status service is busy.")).toBeNull();
});

test.each([
  ["Add a host", "Pair destination"],
  ["Update from Mac", "Update destination"],
])("opens %s from the roster", async (label, destination) => {
  await renderNativeHosts();
  await fireEvent.press(screen.getByRole("button", { name: label }));
  expect(screen.getByRole("header", { name: destination })).toBeOnTheScreen();
});

test("finishing a pending removal preserves a later rename", async () => {
  const { remove, changeRoster, primary, backup } =
    await renderNativeHosts("/settings");
  const pending = Promise.withResolvers<string>();
  remove.mockReturnValueOnce(pending.promise);
  const menu = showMenu();
  await fireEvent.press(screen.getByRole("button", { name: "Hosts" }));
  await voiceAction(
    await screen.findByRole("button", { name: /^MacBook Pro,/ }),
    "remove"
  );
  await selectAction(menu, 0);
  expect(remove).toHaveBeenCalledWith(primary.id);
  await act(() => router.back());
  await fireEvent.press(screen.getByRole("button", { name: "Hosts" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: /^Backup server,/ })
  );
  await fireEvent.changeText(
    screen.getByLabelText("Name on this iPhone"),
    "Offsite backup"
  );
  await fireEvent(
    screen.getByLabelText("Name on this iPhone"),
    "submitEditing"
  );
  await act(() => router.back());
  await changeRoster([backup]);
  await act(() => pending.resolve(ok(null)));
  expect(orderedNames()).toEqual(["Offsite backup"]);
});

test("shows an empty roster after the last host is removed", async () => {
  const { changeRoster, primary } = await renderNativeHosts();
  await screen.findByRole("button", { name: /^MacBook Pro,/ });
  await changeRoster([primary]);
  const menu = showMenu();
  await voiceAction(hostRow("MacBook Pro"), "remove");
  await selectAction(menu, 0);
  expect(await screen.findByText("No hosts on this iPhone.")).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Add a host" })).toBeOnTheScreen();
});

test("persists the reported drop order across relaunch and supports VoiceOver moves", async () => {
  let content: string | null = null;
  const storage: PhoneSettingsStorage = {
    read: () => content,
    write: (text) => {
      content = text;
    },
  };
  const transport = mockHosts();
  const launch = () =>
    renderWithProviders(
      <PhoneSettingsProvider storage={storage}>
        <ExpoRoot context={routes} location="/settings/hosts" />
      </PhoneSettingsProvider>,
      { transport }
    );
  const view = await launch();
  await screen.findByRole("button", { name: /^unreachable,/ });
  const initial = orderedNames();
  const list = jest.mocked(NestedReorderableList).mock.lastCall?.[0];
  if (!list) throw new Error("Expected the native reorder list");
  await act(() => {
    list.onDragStart?.({ index: 1 });
    list.onDragEnd?.({ from: 1, to: 0, cancelled: false });
    list.onReorder?.({ from: 1, to: 0 });
  });
  const moved = [initial[1], initial[0], ...initial.slice(2)];
  expect(orderedNames()).toEqual(moved);
  await view.unmount();
  await launch();
  await screen.findByRole("button", { name: /^unreachable,/ });
  expect(orderedNames()).toEqual(moved);
  const [first, second] = moved;
  await voiceAction(screen.getByLabelText(`Reorder ${first}`), "moveDown");
  expect(orderedNames()).toEqual(initial);
  await voiceAction(screen.getByLabelText(`Reorder ${first}`), "moveUp");
  expect(orderedNames()).toEqual(moved);
  expect(orderedNames().at(1)).toBe(second);
});
