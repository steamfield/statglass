/**
 * The phone data seam: choosing a transport, the phone settings store and
 * the hosts list read through them, on the demo transport.
 */
import type { HostRecord } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import { createDemoTransport } from "@/data/demo";
import { useHosts } from "@/data/hosts-list";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import {
  useIsDemo,
  usePhoneTransport,
  useSetPhoneTransport,
} from "@/data/transport-context";

function HostNames() {
  const hosts = useHosts();
  if (!hosts.data) return <Text>Loading</Text>;
  return <Text>{hosts.data.map((h) => h.display_name).join(" | ")}</Text>;
}

async function demoHosts(): Promise<HostRecord[]> {
  return createDemoTransport().listHosts();
}

test("lists the demo hosts in the transport's order with no phone settings", async () => {
  const expected = (await demoHosts()).map((h) => h.display_name);
  expect(expected.length).toBeGreaterThan(1);

  await renderWithProviders(<HostNames />, {
    transport: createDemoTransport(),
    demo: true,
  });

  expect(await screen.findByText(expected.join(" | "))).toBeOnTheScreen();
});

test("orders, renames and removes hosts from the phone settings", async () => {
  const [first, second, ...rest] = await demoHosts();
  if (!first || !second) throw new Error("the demo needs two hosts");

  await renderWithProviders(<HostNames />, {
    transport: createDemoTransport(),
    settings: {
      hostOrder: [second.id],
      hostNames: { [second.id]: "Studio" },
      removed: [first.id],
    },
  });

  const names = ["Studio", ...rest.map((h) => h.display_name)];
  expect(await screen.findByText(names.join(" | "))).toBeOnTheScreen();
});

function DemoEntry() {
  const setTransport = useSetPhoneTransport();
  const demo = useIsDemo();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => setTransport(createDemoTransport(), true)}
    >
      <Text>{demo ? "Demo" : "No transport"}</Text>
    </Pressable>
  );
}

test("demo remotes stream only when connected and resume after a retry", async () => {
  jest.useFakeTimers();
  const transport = createDemoTransport();
  try {
    const remotes = await transport.listRemoteHosts();
    const frames = new Map<string, number>();
    const cadence = new Map<string, number>();
    for (const {
      config: { id },
    } of remotes) {
      frames.set(id, 0);
      await transport.subscribeLive(
        id,
        (message) => {
          if (message.kind === "frame")
            frames.set(id, (frames.get(id) ?? 0) + 1);
          if (message.kind === "status")
            cadence.set(
              id,
              Math.max(message.interval_ms, message.frame_period_ms)
            );
        },
        { backfillMs: 0 }
      );
    }
    expect(remotes.map(({ status }) => status.state)).toEqual(
      expect.arrayContaining(["connected", "offline", "disabled", "error"])
    );
    await jest.advanceTimersByTimeAsync(1000);
    for (const { config, status } of remotes) {
      expect(frames.get(config.id)).toBe(status.state === "connected" ? 1 : 0);
      expect(cadence.get(config.id)).toBe(
        status.state === "connected" ? 1000 : 0
      );
    }

    const offline = remotes.find(({ status }) => status.state === "offline");
    if (!offline) throw new Error("Missing offline demo host");
    await unwrap(transport.retryRemoteHost(offline.config.id));
    await jest.advanceTimersByTimeAsync(1000);
    expect(frames.get(offline.config.id)).toBe(1);
    expect(cadence.get(offline.config.id)).toBe(1000);
  } finally {
    transport.dispose();
    jest.useRealTimers();
  }
});

test("choosing the demo transport marks the app as demo", async () => {
  await renderWithProviders(<DemoEntry />);
  expect(screen.getByText("No transport")).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole("button"));

  expect(screen.getByText("Demo")).toBeOnTheScreen();
});

function NeedsTransport() {
  usePhoneTransport();
  return null;
}

test("reading the transport before one is chosen says what to do", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(renderWithProviders(<NeedsTransport />)).rejects.toThrow(
    "no transport is chosen yet"
  );
});

function Appearance() {
  const appearance = usePhoneSettings((s) => s.appearance);
  const { set } = usePhoneSettingsActions();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => set({ appearance: "dark" })}
    >
      <Text>{appearance}</Text>
    </Pressable>
  );
}

test("a settings write reaches the readers", async () => {
  await renderWithProviders(<Appearance />);
  expect(screen.getByText("system")).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole("button"));

  expect(screen.getByText("dark")).toBeOnTheScreen();
});
