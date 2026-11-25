import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";
import { ExpoRoot, Stack, usePathname } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { useState } from "react";
import { AppState, Pressable, Text } from "react-native";
import {
  DEFAULT_PHONE_SETTINGS,
  usePhoneSettings,
} from "@/data/phone-settings";
import { HostScreen } from "@/host";
import { CardMenu } from "@/host/card-menu";

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
});
afterEach(() => {
  AppState.currentState = initialAppState;
});

test("the host shows saved card order and density and opens the selected module", async () => {
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
    const buttons = cards.getAllByRole("button");
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
    const network = cards.getByRole("button", { name: /^Network,/ });
    expect(within(network).queryByRole("image")).not.toBeOnTheScreen();
    await fireEvent(network, "accessibilityAction", {
      nativeEvent: { actionName: "menu" },
    });
    expect(
      await screen.findByRole("header", { name: "Network card" })
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    await fireEvent.press(screen.getByRole("button", { name: /^Network,/ }));
    expect(
      await screen.findByText(`/${MOCK_HOST_ID}/network`)
    ).toBeOnTheScreen();
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
    const buttons = cards.getAllByRole("button");
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
