import "react-native-gesture-handler/jestSetup";
import { expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { ExpoRoot, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { Fragment } from "react";
import * as Native from "react-native";
import * as Reanimated from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BackButton, useAccessibilityEscape } from "@/ui/back-button";
import { DemoBadge } from "@/ui/demo-badge";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { HeaderButton } from "@/ui/header-button";
import { Icon, type IconName } from "@/ui/icons";
import { ListRow } from "@/ui/list-row";
import { screenOptions } from "@/ui/screen-options";
import { ScreenScroll } from "@/ui/screen-scroll";
import { SwipeRow } from "@/ui/swipe-row";
import { colorsForScheme } from "@/ui/theme-colors";

jest.mock("expo-symbols", () => require("./symbol-view-stub"));
jest.mock("react-native-reanimated", () => ({
  ...require("@test/ui/reanimated-list-stub").reanimatedListStub,
  // Jest cannot drag an animated view. Keep the real action pressable in
  // the still renderer so its wiring can be exercised after it is revealed.
  useAnimatedStyle: (read: () => { pointerEvents?: string }) => {
    const { pointerEvents: _, ...style } = read();
    return style;
  },
  withSpring: (target: number) => target,
}));

const SYMBOLS: Record<IconName, IconName> = {
  "chevron.left": "chevron.left",
  "chevron.right": "chevron.right",
  "chevron.down": "chevron.down",
  "chevron.up": "chevron.up",
  gearshape: "gearshape",
  xmark: "xmark",
  ellipsis: "ellipsis",
  checkmark: "checkmark",
  "line.3.horizontal": "line.3.horizontal",
  "apple.logo": "apple.logo",
  "server.rack": "server.rack",
  "doc.on.doc": "doc.on.doc",
};

it.each(Object.values(SYMBOLS))("renders the %s SF Symbol", async (name) => {
  await renderWithProviders(<Icon name={name} accessibilityLabel="Preview" />);
  const symbol = screen.getByRole("image", { name: "Preview" });
  expect(symbol).toHaveProp("testID", name);
  expect(symbol).toBeVisible();
});

it.each(["light", "dark"] as const)(
  "uses an unfilled 44 pt header button with a 28 pt %s foreground symbol",
  async (scheme) => {
    jest.spyOn(Native, "useColorScheme").mockReturnValue(scheme);
    const onPress = jest.fn();
    await renderWithProviders(
      <HeaderButton
        icon="gearshape"
        accessibilityLabel="Settings"
        onPress={onPress}
      />
    );

    const button = screen.getByRole("button", { name: "Settings" });
    expect(button).toHaveStyle({
      width: 44,
      height: 44,
      backgroundColor: undefined,
    });
    expect(within(button).getByTestId("gearshape")).toHaveStyle({
      width: 28,
      height: 28,
      tintColor: colorsForScheme(scheme).foreground,
    });
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  }
);

function Settings() {
  const escapeProps = useAccessibilityEscape();
  return (
    <Native.View
      accessible
      accessibilityLabel="Settings screen"
      {...escapeProps}
    />
  );
}

const routes = getMockContext({
  _layout: () => (
    <Stack screenOptions={screenOptions(colorsForScheme("light"))} />
  ),
  index: () => (
    <Native.Pressable
      accessibilityRole="button"
      onPress={() => router.push("/settings")}
    >
      <Native.Text>Open settings</Native.Text>
    </Native.Pressable>
  ),
  settings: Settings,
});

it("goes back by tapping the native chevron or making the VoiceOver escape gesture", async () => {
  await renderWithProviders(<ExpoRoot context={routes} location="/" />);
  const openSettings = () =>
    fireEvent.press(screen.getByRole("button", { name: "Open settings" }));
  await openSettings();
  const back = screen.getByRole("button", { name: "Back" });
  expect(back).toHaveStyle({ width: 44, height: 44 });
  expect(within(back).getByTestId("chevron.left")).toBeVisible();
  expect(within(back).queryByText("Back")).toBeNull();
  await fireEvent.press(back);
  expect(screen.getByRole("button", { name: "Open settings" })).toBeVisible();

  await openSettings();
  await fireEvent(
    screen.getByLabelText("Settings screen"),
    "accessibilityEscape"
  );
  expect(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
});

it("offers no Back button on a cold deep link", async () => {
  await renderWithProviders(<ExpoRoot context={routes} location="/settings" />);
  expect(screen.getByLabelText("Settings screen")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
});

it("lets a screen supply its own escape and back actions", async () => {
  const onEscape = jest.fn();
  const onBack = jest.fn();
  function Screen() {
    const escapeProps = useAccessibilityEscape(onEscape);
    return (
      <Native.View accessible accessibilityLabel="Screen" {...escapeProps}>
        <BackButton onPress={onBack} />
      </Native.View>
    );
  }
  await renderWithProviders(<Screen />);
  await fireEvent(screen.getByLabelText("Screen"), "accessibilityEscape");
  await fireEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(onEscape).toHaveBeenCalledTimes(1);
  expect(onBack).toHaveBeenCalledTimes(1);
});

it("gives both appearances native material and a pushed-screen back chevron", async () => {
  for (const scheme of ["light", "dark"] as const) {
    const colors = colorsForScheme(scheme);
    const options = screenOptions(colors, { largeTitle: true });
    expect(options).toMatchObject({
      headerTransparent: true,
      headerBlurEffect: "systemChromeMaterial",
      headerLargeTitle: true,
      headerLargeTitleShadowVisible: false,
      headerBackVisible: false,
      gestureEnabled: true,
      fullScreenGestureEnabled: false,
      headerTitleStyle: { fontWeight: "600", color: colors.foreground },
      headerLargeTitleStyle: { fontWeight: "600", color: colors.foreground },
      scrollEdgeEffects: { top: "hidden" },
    });
    expect(options.unstable_headerLeftItems?.({ canGoBack: true })).toEqual([
      {
        type: "custom",
        element: expect.anything(),
        hidesSharedBackground: true,
      },
    ]);
    expect(options.headerLeft?.({ canGoBack: false })).toBeNull();
    expect(options.unstable_headerLeftItems?.({ canGoBack: false })).toEqual(
      []
    );
  }

  const colors = colorsForScheme("light");
  const root = screenOptions(colors, { root: true });
  expect(root.headerLargeTitle).toBe(false);
  expect(root.headerLeft).toBeUndefined();
  expect(root.unstable_headerLeftItems).toBeUndefined();
  const nativeItem = screenOptions(colors).unstable_headerLeftItems?.({
    canGoBack: true,
  })[0];
  await renderWithProviders(
    <Native.View>
      {nativeItem?.type === "custom" && nativeItem.element}
    </Native.View>
  );
  const back = screen.getByRole("button", { name: "Back" });
  expect(within(back).getByTestId("chevron.left")).toBeVisible();
});

it.each([
  ["default", 1, 34],
  ["larger text", 1.1, 37.4],
  ["XXXL", 1.235, 41.99],
  ["AX1", 1.786, 41.99],
] as const)(
  "keeps the inline title at 17 pt and sizes the large title at %s",
  (_size, scale, largeTitleSize) => {
    jest.spyOn(Native.PixelRatio, "getFontScale").mockReturnValue(scale);
    const options = screenOptions(colorsForScheme("light"), {
      largeTitle: true,
    });
    expect(options).toMatchObject({
      headerTitleStyle: { fontSize: 17 },
      headerLargeTitleStyle: { fontSize: expect.closeTo(largeTitleSize) },
    });
  }
);

it("uses automatic scroll insets below visible chrome", async () => {
  jest.spyOn(Native, "useColorScheme").mockReturnValue("dark");
  await renderWithProviders(
    <ScreenScroll testID="screen">
      <Native.Text>Settings</Native.Text>
    </ScreenScroll>
  );
  expect(screen.getByTestId("screen")).toHaveProp(
    "contentInsetAdjustmentBehavior",
    "automatic"
  );
  expect(screen.getByTestId("screen")).toHaveStyle({
    backgroundColor: colorsForScheme("dark").background,
  });
});

it("clips the headerless scroll viewport between the two safe-area insets", async () => {
  await renderWithProviders(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 402, height: 874 },
        insets: { top: 62, bottom: 34, left: 0, right: 0 },
      }}
    >
      <ScreenScroll headerShown={false} testID="screen">
        <Native.Text>Welcome</Native.Text>
      </ScreenScroll>
    </SafeAreaProvider>
  );
  const scroll = screen.getByTestId("screen");
  expect(scroll).toHaveProp("contentInsetAdjustmentBehavior", "never");
  expect(scroll.parent).toHaveStyle({
    paddingTop: 62,
    paddingBottom: 34,
    overflow: "hidden",
  });
  expect(screen.getByText("Welcome")).toBeVisible();
});

it("renders grouped labels, values, accessories and a destructive row", async () => {
  jest.spyOn(Native, "useColorScheme").mockReturnValue("light");
  const open = jest.fn();
  const colors = colorsForScheme("light");
  await renderWithProviders(
    <ListSection title="Host settings" footer="History stays on the host.">
      <GroupedList>
        <ListRow title="Version" value="1.0" />
        <ListRow title="System" accessory="checkmark" onPress={jest.fn()} />
        <ListRow
          title="Mac mini"
          subtitle="Online"
          glyph="apple.logo"
          accessory="chevron"
          onPress={open}
          accessibilityHint="Opens host settings"
        />
        <ListRow title="Remove host" destructive onPress={jest.fn()} />
      </GroupedList>
    </ListSection>
  );

  expect(screen.getByRole("header", { name: "Host settings" })).toHaveStyle({
    fontSize: 13,
    fontWeight: "600",
  });
  expect(screen.getByText("History stays on the host.")).toHaveStyle({
    fontSize: 12,
  });
  expect(screen.getByLabelText("Version")).toHaveAccessibilityValue({
    text: "1.0",
  });
  expect(screen.getByText("1.0")).toHaveStyle({
    textAlign: "right",
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  });
  expect(
    screen.getByRole("button", { name: "System", selected: true })
  ).toBeVisible();
  expect(screen.getByTestId("checkmark")).toBeVisible();
  const host = screen.getByRole("button", { name: "Mac mini, Online" });
  expect(host).toHaveStyle({ minHeight: 44 });
  expect(host).toHaveProp("accessibilityHint", "Opens host settings");
  expect(within(host).getByText("Mac mini")).toHaveStyle({ fontSize: 17 });
  expect(within(host).getByText("Online")).toHaveStyle({ fontSize: 12 });
  expect(within(host).getByTestId("apple.logo")).toBeVisible();
  expect(within(host).getByTestId("chevron.right")).toBeVisible();
  await fireEvent.press(host);
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Remove host")).toHaveStyle({
    color: colors.destructive,
  });
});

it("draws dividers between rows inside a list fragment", async () => {
  jest.spyOn(Native, "useColorScheme").mockReturnValue("light");
  const view = await renderWithProviders(
    <GroupedList>
      <Fragment key="versions">
        <ListRow title="Version" />
        <ListRow title="Protocol" />
      </Fragment>
      <ListRow title="Core" />
    </GroupedList>
  );
  const dividers = view.container.queryAll(({ props }) => {
    const style = Native.StyleSheet.flatten<Native.ViewStyle>(props.style);
    return (
      style?.height === Native.StyleSheet.hairlineWidth &&
      style?.backgroundColor === colorsForScheme("light")["border-subtle"]
    );
  });
  expect(dividers).toHaveLength(2);
});

it("leaves an unselected row quiet and a trailing control independently usable", async () => {
  const activateRow = jest.fn();
  const activateSwitch = jest.fn<(value: boolean) => void>();
  await renderWithProviders(
    <>
      <GroupedList>{false}</GroupedList>
      <ListSection>
        <GroupedList>
          <ListRow
            title="Live updates"
            accessory="checkmark"
            selected={false}
            onPress={activateRow}
            trailing={
              <Native.Switch
                accessibilityLabel="Live updates on cellular"
                onValueChange={activateSwitch}
              />
            }
          />
        </GroupedList>
      </ListSection>
    </>
  );
  const row = screen.getByRole("button", {
    name: "Live updates",
    selected: false,
  });
  expect(row).not.toHaveAccessibilityValue({ text: /./ });
  expect(screen.queryByTestId("checkmark")).toBeNull();
  expect(screen.queryByRole("header")).toBeNull();
  await fireEvent(
    screen.getByRole("switch", { name: "Live updates on cellular" }),
    "valueChange",
    true
  );
  expect(activateSwitch).toHaveBeenCalledWith(true);
  expect(activateRow).not.toHaveBeenCalled();
});

it("keeps a wrapped row pressable and offers its destructive action to VoiceOver", async () => {
  jest.spyOn(Native, "useColorScheme").mockReturnValue("light");
  jest.useFakeTimers();
  try {
    const remove = jest.fn();
    const open = jest.fn();
    await renderWithProviders(
      <SwipeRow actionLabel="Remove Mac mini" onAction={remove}>
        <Native.View>
          <ListRow title="Mac mini" subtitle="Online" onPress={open} />
        </Native.View>
      </SwipeRow>
    );
    const row = screen.getByRole("button", { name: "Mac mini, Online" });
    await fireEvent.press(row);
    expect(open).toHaveBeenCalledTimes(1);
    const actions: Native.ViewProps["accessibilityActions"] =
      row.props.accessibilityActions;
    const removeAction = actions?.find(
      ({ label }) => label === "Remove Mac mini"
    );
    expect(removeAction).toBeDefined();
    await fireEvent(row, "accessibilityAction", {
      nativeEvent: { actionName: "other" },
    });
    expect(remove).not.toHaveBeenCalled();
    await fireEvent(row, "accessibilityAction", {
      nativeEvent: { actionName: removeAction?.name },
    });
    expect(remove).toHaveBeenCalledTimes(1);

    // The action is hidden from VoiceOver because the row already provides it.
    const action = screen.getByRole("button", {
      name: "Remove Mac mini",
      includeHiddenElements: true,
    });
    expect(action).toHaveStyle({ minHeight: 44, minWidth: 44 });
    expect(
      within(action).getByText("Remove Mac mini", {
        includeHiddenElements: true,
      })
    ).toHaveStyle({
      color: colorsForScheme("light")["destructive-foreground"],
    });
    expect(
      screen.queryByRole("button", { name: "Remove Mac mini" })
    ).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    await act(() => jest.runOnlyPendingTimersAsync());
  } finally {
    jest.useRealTimers();
  }
});

it("opens the native demo sheet, and only its destructive choice exits", async () => {
  const showSheet = jest
    .spyOn(Native.ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => {});
  const exit = jest.fn();
  await renderWithProviders(<DemoBadge onExit={exit} />);
  const button = screen.getByRole("button", { name: "Demo" });
  expect(button.props).toMatchObject({
    accessibilityLabel: "Demo",
    accessibilityHint: "Shows the option to exit demo mode",
  });
  expect(button).toHaveStyle({ minHeight: 44, minWidth: 44 });
  expect(within(button).getByText("Demo")).toHaveStyle({ fontSize: 13 });
  await fireEvent.press(button);
  expect(showSheet).toHaveBeenCalledWith(
    {
      options: ["Exit demo", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    },
    expect.any(Function)
  );
  const cancel = showSheet.mock.calls[0]?.[1];
  cancel?.(1);
  expect(exit).not.toHaveBeenCalled();
  await fireEvent.press(button);
  const confirm = showSheet.mock.calls[1]?.[1];
  confirm?.(0);
  expect(exit).toHaveBeenCalledTimes(1);
});

it("asks Reanimated to skip the swipe spring in Low Power Mode", async () => {
  jest
    .spyOn(Native.AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(false);
  const spring = jest.spyOn(Reanimated, "withSpring");
  jest.useFakeTimers();
  try {
    await renderWithProviders(
      <SwipeRow actionLabel="Remove" onAction={jest.fn()}>
        <ListRow title="Mac mini" />
      </SwipeRow>
    );
    const row = screen.getByLabelText("Mac mini");
    const actions: Native.ViewProps["accessibilityActions"] =
      row.props.accessibilityActions;
    const removeAction = actions?.find(({ label }) => label === "Remove");
    expect(removeAction).toBeDefined();
    const remove = () =>
      fireEvent(row, "accessibilityAction", {
        nativeEvent: { actionName: removeAction?.name },
      });
    await remove();
    await act(() => jest.runOnlyPendingTimersAsync());
    expect(spring).toHaveBeenLastCalledWith(
      0,
      expect.objectContaining({ reduceMotion: Reanimated.ReduceMotion.System })
    );

    await act(() => {
      Native.DeviceEventEmitter.emit("mockLowPowerModeChanged", {
        lowPowerMode: true,
      });
    });
    await remove();
    await act(() => jest.runOnlyPendingTimersAsync());
    expect(spring).toHaveBeenLastCalledWith(
      0,
      expect.objectContaining({ reduceMotion: Reanimated.ReduceMotion.Always })
    );
  } finally {
    jest.useRealTimers();
  }
});
