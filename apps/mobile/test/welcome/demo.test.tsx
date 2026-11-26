import type { LiveMsg } from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { FakeNative, installNative, ok } from "@test/transport/fake-native";
import { Stack } from "expo-router";
import {
  act,
  fireEvent,
  renderRouter,
  screen,
  testRouter,
} from "expo-router/testing-library";
import { useEffect } from "react";
import { ActionSheetIOS } from "react-native";
import DemoRoute from "@/app/demo";
import FirstLaunch from "@/app/index";
import type { PhoneTransport } from "@/data/seam";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { AppProviders } from "@/lib/providers";
import { DemoProvider, useDemo } from "@/session/demo";
import { PairingProvider } from "@/session/pairing";
import { CoreProvider } from "@/transport";
import { DemoBadge } from "@/ui/demo-badge";
import { Text } from "@/ui/text";

function Root() {
  return (
    <AppProviders>
      <CoreProvider>
        <DemoProvider>
          <PairingProvider>
            <Stack screenOptions={{ headerShown: false }} />
          </PairingProvider>
        </DemoProvider>
      </CoreProvider>
    </AppProviders>
  );
}

function controls(report: (transport: PhoneTransport | null) => void) {
  return function DemoControls() {
    const { active, exit } = useDemo();
    const transport = useOptionalPhoneTransport();
    useEffect(() => report(transport), [transport]);
    return active ? (
      <DemoBadge onExit={exit} />
    ) : (
      <Text variant="body">Native hosts</Text>
    );
  };
}

function WelcomeWithTransport({
  report,
}: {
  report(transport: PhoneTransport | null): void;
}) {
  const transport = useOptionalPhoneTransport();
  useEffect(() => report(transport), [report, transport]);
  return <FirstLaunch />;
}

function installDemoMenu() {
  const menu = jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => {});
  return async () => {
    await fireEvent.press(screen.getByRole("button", { name: "Demo" }));
    const call = menu.mock.lastCall;
    if (!call) throw new Error("The demo menu did not open");
    const [options, select] = call;
    const exit = options.options.indexOf("Exit demo");
    expect(exit).toBeGreaterThanOrEqual(0);
    await act(() => select(exit));
  };
}

test.each(["exit", "unmount"] as const)(
  "keeps demo data across a renamed route and stops frames on %s",
  async (end) => {
    jest.useFakeTimers();
    try {
      const report = jest.fn<(transport: PhoneTransport | null) => void>();
      const DemoControls = controls(report);
      const exitDemo = installDemoMenu();
      const router = await renderRouter({
        _layout: Root,
        index: FirstLaunch,
        "(hosts)/index": DemoControls,
        "renamed-surface": DemoControls,
      });
      await fireEvent.press(
        screen.getByRole("button", { name: "Try demo hosts" })
      );
      expect(router.getSegments()).toEqual(["(hosts)"]);
      const mock = report.mock.lastCall?.[0];
      if (!mock) throw new Error("Demo transport was not installed");
      const receive = jest.fn<(message: LiveMsg) => void>();
      const subscription = await mock.subscribeLive(MOCK_HOST_ID, receive);
      try {
        await testRouter.replace("/renamed-surface");
        expect(screen.getByRole("button", { name: "Demo" })).toBeOnTheScreen();
        expect(report.mock.lastCall?.[0]).toBe(mock);
        receive.mockClear();
        await act(() => jest.advanceTimersByTimeAsync(1000));
        expect(
          receive.mock.calls.some(([message]) => message.kind === "frame")
        ).toBe(true);

        if (end === "exit") {
          await exitDemo();
          expect(router.getSegments()).toEqual([]);
          expect(
            screen.getByRole("button", { name: "Try demo hosts" })
          ).toBeOnTheScreen();
        } else {
          await router.unmount();
        }

        receive.mockClear();
        await act(() => jest.advanceTimersByTimeAsync(5000));
        expect(receive).not.toHaveBeenCalled();
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      jest.useRealTimers();
    }
  }
);

test("exit restores the ready native transport and opens welcome for an empty roster", async () => {
  const native = new FakeNative();
  native.call.mockImplementation(async (method) =>
    ok(method === "list_hosts" ? [] : null)
  );
  installNative(native);
  const report = jest.fn<(transport: PhoneTransport | null) => void>();
  const DemoControls = controls(report);
  const exitDemo = installDemoMenu();
  const router = await renderRouter({
    _layout: Root,
    index: () => <WelcomeWithTransport report={report} />,
    "(hosts)/index": DemoControls,
  });
  await fireEvent.press(
    await screen.findByRole("button", { name: "Try demo hosts" })
  );
  const demo = report.mock.lastCall?.[0];
  await exitDemo();
  expect(router.getSegments()).toEqual([]);
  expect(
    await screen.findByRole("button", { name: "Add a host" })
  ).toBeOnTheScreen();
  const restored = report.mock.lastCall?.[0];
  expect(restored).toBeDefined();
  expect(restored).not.toBe(demo);
  expect(await restored?.listHosts()).toEqual([]);
});

test("exit from a demo deep link returns to the saved native roster", async () => {
  const native = new FakeNative();
  const saved = await createMockTransport().listHosts();
  native.call.mockImplementation(async (method) =>
    ok(method === "list_hosts" ? saved : null)
  );
  installNative(native);
  const report = jest.fn<(transport: PhoneTransport | null) => void>();
  const exitDemo = installDemoMenu();
  const router = await renderRouter(
    {
      _layout: Root,
      index: FirstLaunch,
      demo: DemoRoute,
      "(hosts)/index": controls(report),
    },
    { initialUrl: "/demo" }
  );
  await screen.findByRole("button", { name: "Demo" });
  const demo = report.mock.lastCall?.[0];

  await exitDemo();

  expect(await screen.findByText("Native hosts")).toBeOnTheScreen();
  expect(router.getSegments()).toEqual(["(hosts)"]);
  const restored = report.mock.lastCall?.[0];
  expect(restored).not.toBe(demo);
  expect(await restored?.listHosts()).toEqual(saved);
});
