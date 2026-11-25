import { hostRecord, scenarioFlags } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, ok } from "@test/transport/fake-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { ExpoRoot, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { ActionSheetIOS, Alert } from "react-native";
import HostDetail from "@/app/settings/host/[host]";
import { useHosts } from "@/data/hosts-list";
import { createNativeTransport } from "@/transport";
import { Text } from "@/ui/text";

const hostUrl = "/settings/host/remote-studio";
const transport = () => createMockTransport({ scenarios: ["hosts-dashboard"] });

function UpdatedRoster() {
  const hosts = useHosts();
  if (!hosts.data) return <Text variant="body">Loading roster…</Text>;
  return (
    <Text variant="body">
      {hosts.data.map(({ display_name }) => display_name).join(", ") ||
        "Empty roster"}
    </Text>
  );
}

const routes = getMockContext({
  _layout: () => <Stack />,
  index: () => <Text variant="title">First launch</Text>,
  "settings/hosts": UpdatedRoster,
  "settings/host/[host]": HostDetail,
  pair: () => <Text variant="title">Pair destination</Text>,
  "update-from-mac": () => <Text variant="title">Update destination</Text>,
});

test("validates the inline name and saves a trimmed name on submit", async () => {
  await renderWithProviders(<ExpoRoot context={routes} location={hostUrl} />, {
    transport: transport(),
  });
  const field = () => screen.getByLabelText("Name on this iPhone");
  expect(await screen.findByDisplayValue("studio")).toBeOnTheScreen();
  for (const invalid of ["   ", "x".repeat(65)]) {
    await fireEvent.changeText(field(), invalid);
    await fireEvent(field(), "submitEditing");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a name between 1 and 64 characters."
    );
  }
  const name = "a".repeat(64);
  await fireEvent.changeText(field(), `  ${name}  `);
  await fireEvent(field(), "submitEditing");
  expect(screen.getByDisplayValue(name)).toBeOnTheScreen();
  await act(() => router.push("/settings/hosts"));
  expect(await screen.findByText(new RegExp(name))).toBeOnTheScreen();
});

test.each([
  ["Re-pair", "Pair destination"],
  ["Update from Mac", "Update destination"],
])(
  "opens the destination for %s with back navigation",
  async (label, destination) => {
    await renderWithProviders(
      <ExpoRoot context={routes} location={hostUrl} />,
      { transport: transport() }
    );
    await fireEvent.press(await screen.findByRole("button", { name: label }));
    expect(screen.getByRole("header", { name: destination })).toBeOnTheScreen();
    await act(() => router.back());
    expect(await screen.findByDisplayValue("studio")).toBeOnTheScreen();
  }
);

test("removes the demo host from the phone list on confirmation", async () => {
  const demo = transport();
  const roster = await demo.listHosts();
  const menu = jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => undefined);
  await renderWithProviders(<ExpoRoot context={routes} location={hostUrl} />, {
    transport: demo,
    demo: true,
  });
  await fireEvent.press(await screen.findByRole("button", { name: "Remove" }));
  expect(menu).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: ["Remove studio", "Cancel"],
      destructiveButtonIndex: 0,
      message:
        "This iPhone stops monitoring studio. Its history stays on the host.",
    }),
    expect.any(Function)
  );
  const action = menu.mock.lastCall?.[1];
  if (!action) throw new Error("Expected the removal confirmation");
  await act(() => action(0));
  expect(
    await screen.findByText(
      roster
        .filter(({ id }) => id !== "remote-studio")
        .map(({ display_name }) => display_name)
        .join(", ")
    )
  ).toBeOnTheScreen();
  expect(await demo.listHosts()).toEqual(roster);
});

test("shows an explanation for a missing host", async () => {
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings/host/missing" />,
    { transport: transport() }
  );
  expect(
    await screen.findByText("This host is no longer on this iPhone.")
  ).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

test("stays on the detail after a failed native removal and returns on success", async () => {
  const native = new FakeNative();
  const host = hostRecord(scenarioFlags([]), Date.now());
  let roster = [host];
  let canRemove = false;
  native.call.mockImplementation(async (method) => {
    if (method === "list_hosts") return ok(roster);
    if (method === "list_remote_hosts") return ok([]);
    if (method !== "remove_host") return ok(null);
    if (!canRemove)
      return JSON.stringify({
        status: "error",
        error: { kind: "internal", message: "Host removal is busy." },
      });
    roster = [];
    return ok(null);
  });
  const menu = jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => undefined);
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings/hosts" />,
    {
      transport: createNativeTransport(native),
    }
  );
  await act(() =>
    router.push({
      pathname: "/settings/host/[host]",
      params: { host: host.id },
    })
  );
  async function remove() {
    await fireEvent.press(
      await screen.findByRole("button", { name: "Remove" })
    );
    const confirm = menu.mock.lastCall?.[1];
    if (!confirm) throw new Error("Expected the removal confirmation");
    await act(() => confirm(0));
  }
  await remove();
  expect(alert).toHaveBeenCalledWith(
    "Couldn’t remove MacBook Pro",
    "Host removal is busy."
  );
  expect(screen.getByDisplayValue("MacBook Pro")).toBeOnTheScreen();
  canRemove = true;
  await remove();
  expect(await screen.findByText("Empty roster")).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

test("retries a failed Routes read without leaving host detail", async () => {
  const peer = transport();
  const failure = {
    kind: "store",
    message: "The status service is busy.",
  } as const;
  peer.failNext("listRemoteHosts", failure);
  await renderWithProviders(<ExpoRoot context={routes} location={hostUrl} />, {
    transport: peer,
  });
  expect(
    await screen.findByText("The status service is busy.")
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByLabelText("LAN")).toHaveAccessibilityValue({
    text: "studio.local",
  });
});
