import { MOCK_HOST_ID } from "@core/mock/fixtures";
import {
  PHONE_LAST_SEEN_MS,
  phoneCommandFailures,
} from "@core/mock/phone-errors";
import { createMockTransport } from "@core/mock-transport";
import { localNetworkProblem } from "@core/phone-connection";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { AccessibilityInfo, Linking, View } from "react-native";
import { ProblemBanner } from "@/connection/problem-banner";
import { HostScreen } from "@/host";
import { Text } from "@/ui/text";

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "(hosts)/index": () => <View />,
  "(hosts)/[host]/index": HostScreen,
  pair: () => <Text variant="title">Pairing screen</Text>,
});
const localNetworkFixture = localNetworkProblem();

beforeEach(() => {
  jest.useFakeTimers({ now: PHONE_LAST_SEEN_MS });
  mockAppState();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function openHost(name: string, displayName?: string) {
  const id = `phone-${name}`;
  const transport = createMockTransport({
    scenarios: ["phone-errors"],
    historyRows: 2,
  });
  const removed = (await transport.listHosts())
    .filter((host) => host.id !== id)
    .map((host) => host.id);
  const view = await renderWithProviders(
    <ExpoRoot context={context} location={new URL(`statglass:///${id}`)} />,
    {
      transport,
      settings: {
        removed,
        ...(displayName ? { hostNames: { [id]: displayName } } : {}),
      },
    }
  );
  return { transport, unmount: view.unmount };
}

test.each([
  [
    "tailscale-down",
    "Tailscale is off on this iPhone",
    /connect Tailscale/,
    "Open Tailscale",
  ],
  [
    "timeout",
    "Connection to timeout timed out",
    /tailnet access rules/,
    "Retry",
  ],
  [
    "tailscale-ssh",
    "Tailscale SSH is answering on tailscale-ssh",
    /tailscale set --ssh=false/,
    "Retry",
  ],
  [
    "name-not-resolved",
    "Couldn’t find name-not-resolved",
    /Check the host name/,
    "Retry",
  ],
  ["refused", "refused refused the SSH connection", /SSH is enabled/, "Retry"],
  [
    "unreachable",
    "Can’t reach unreachable",
    /reachable from this network/,
    "Retry",
  ],
  ["offline", "offline is offline", /awake and online/, "Retry"],
  [
    "app-not-running",
    "StatGlass isn’t running on app-not-running",
    /Open StatGlass on app-not-running/,
    "Retry",
  ],
  [
    "monitoring-off",
    "Remote monitoring is off on monitoring-off",
    /Allow remote monitoring/,
    "Retry",
  ],
  [
    "agent-not-running",
    "The StatGlass agent isn’t running on agent-not-running",
    /wait for its update/,
    "Retry",
  ],
  [
    "identity-changed",
    "Re-pair as a new host",
    /reported a different identity/,
    "Re-pair",
  ],
  [
    "no-longer-authorized",
    "This iPhone is no longer authorized on no-longer-authorized",
    /restore access from this iPhone/,
    "Re-pair",
  ],
  [
    "host-key-changed",
    "The SSH host key changed on host-key-changed",
    /Confirm the new SSH fingerprint/,
    "Re-pair",
  ],
  [
    "key-not-accepted",
    "Key not accepted by sshd",
    /install this iPhone’s key/,
    "Re-pair",
  ],
  [
    "update-host",
    "Update StatGlass on update-host",
    /Install a newer version/,
    null,
  ],
  ["update-app", "Update this app", /from the App Store/, null],
  [
    "incompatible",
    "Can’t connect to incompatible with this StatGlass version",
    /allows remote monitoring/,
    null,
  ],
  [
    "local-offline",
    "This iPhone is offline",
    /Connect to Wi-Fi or cellular/,
    null,
  ],
  [
    "phone-key-unavailable",
    "This iPhone’s key is unavailable",
    /Unlock your iPhone and retry/,
    "Retry",
  ],
  [
    "open-error",
    "Check the connection settings for open-error",
    /saved host address and SSH settings/,
    "Retry",
  ],
  [
    "open-signer-error",
    "Couldn’t start the connection to open-signer-error",
    /close and reopen StatGlass/,
    "Retry",
  ],
  [
    "protocol",
    "Couldn’t read the response from protocol",
    /check the StatGlass versions/,
    "Retry",
  ],
  [
    "internal",
    "StatGlass lost its connection to internal",
    /Retry to start a new connection/,
    "Retry",
  ],
] as const)(
  "shows the %s recovery on the host page",
  async (name, title, recovery, action) => {
    const { transport, unmount } = await openHost(name);
    try {
      expect(await screen.findByText(title)).toBeOnTheScreen();
      expect(screen.getByText(recovery)).toBeOnTheScreen();
      if (action) {
        expect(screen.getByRole("button", { name: action })).toBeOnTheScreen();
      } else {
        expect(
          screen.queryByRole("button", {
            name: /^(Retry|Re-pair|Open Tailscale|Open Settings)$/,
          })
        ).toBeNull();
      }
      if (name === "offline")
        expect(screen.getByText("Offline since 14:02")).toBeOnTheScreen();
    } finally {
      await unmount();
      transport.dispose();
    }
  }
);

test("Re-pair opens the pairing route", async () => {
  const { transport, unmount } = await openHost("host-key-changed");
  try {
    await fireEvent.press(
      await screen.findByRole("button", { name: "Re-pair" })
    );
    expect(await screen.findByText("Pairing screen")).toBeOnTheScreen();
  } finally {
    await unmount();
    transport.dispose();
  }
});

test("the recovery uses the host name shown on this iPhone", async () => {
  const { transport, unmount } = await openHost("monitoring-off", "Studio");
  try {
    expect(
      await screen.findByText("Remote monitoring is off on Studio")
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Turn on Allow remote monitoring in StatGlass Settings on Studio, then retry."
      )
    ).toBeOnTheScreen();
  } finally {
    await unmount();
    transport.dispose();
  }
});

test("Retry calls the host command and clears the banner on recovery", async () => {
  const { transport, unmount } = await openHost("app-not-running");
  try {
    const retry = jest.spyOn(transport, "retryRemoteHost");
    await fireEvent.press(await screen.findByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("phone-app-not-running");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    );
  } finally {
    await unmount();
    transport.dispose();
  }
});

test("an acknowledged Retry shows the attempt in progress before recovery", async () => {
  const { transport, unmount } = await openHost("app-not-running");
  try {
    // The mock retry acknowledges first. Publish the retained failure Rust sends as it dials.
    await fireEvent.press(await screen.findByRole("button", { name: "Retry" }));
    await act(() =>
      transport.pushRemoteStatus("phone-app-not-running", {
        state: "connecting",
        dialing: true,
        failure_kind: "app_not_running",
        last_seen_ms: PHONE_LAST_SEEN_MS,
      })
    );
    expect(await screen.findByText("Reconnecting")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    await unmount();
    transport.dispose();
  }
});

test("Open Tailscale opens the app URL and gives a fallback when unavailable", async () => {
  const failure = new Error("No handler for tailscale");
  const open = jest.spyOn(Linking, "openURL").mockRejectedValueOnce(failure);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const { transport, unmount } = await openHost("tailscale-down");
  try {
    await fireEvent.press(
      await screen.findByRole("button", { name: "Open Tailscale" })
    );
    expect(open).toHaveBeenCalledWith("tailscale://");
    expect(
      await screen.findByText(
        "Open Tailscale from the Home Screen, or install it from the App Store."
      )
    ).toBeOnTheScreen();
    expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
  } finally {
    await unmount();
    transport.dispose();
  }
});

test("a rejected Retry keeps the recovery available and explains the failure", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  const { transport, unmount } = await openHost("app-not-running");
  try {
    transport.failNext("retryRemoteHost", phoneCommandFailures.retryTimeout);
    await fireEvent.press(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("alert", { name: "The host timed out." })
    ).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(announce).toHaveBeenCalledWith("The host timed out.");
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: phoneCommandFailures.retryTimeout })
    );
  } finally {
    await unmount();
    transport.dispose();
  }
});

test("the Open Settings action opens iPhone Settings", async () => {
  const open = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
  const transport = createMockTransport({ historyRows: 2 });
  function SettingsHelp() {
    return <ProblemBanner host={MOCK_HOST_ID} problem={localNetworkFixture} />;
  }
  const view = await renderWithProviders(
    <ExpoRoot context={getMockContext({ index: SettingsHelp })} location="/" />,
    { transport }
  );
  try {
    expect(
      screen.getByText("StatGlass needs Local Network access")
    ).toBeOnTheScreen();
    expect(
      screen.getByText("Allow Local Network access for StatGlass in Settings.")
    ).toBeOnTheScreen();
    await fireEvent.press(
      await screen.findByRole("button", { name: "Open Settings" })
    );
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
    transport.dispose();
  }
});

test("announces the same problem once as two retry times are published", async () => {
  const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  announce.mockClear();
  const { transport, unmount } = await openHost("agent-not-running");
  try {
    const id = "phone-agent-not-running";
    await screen.findByText(/Retrying at/);
    for (const [minute, label] of [
      [6, "14:08"],
      [7, "14:09"],
    ] as const) {
      await act(() => {
        transport.pushRemoteStatus(id, {
          next_attempt_ms: new Date(2026, 10, 24, 14, minute).getTime(),
        });
        transport.emitHostsChanged();
      });
      expect(
        await screen.findByText(new RegExp(`Retrying at ${label}`))
      ).toBeOnTheScreen();
    }
    expect(announce).toHaveBeenCalledTimes(1);
    await act(() =>
      transport.pushRemoteStatus(id, { failure_kind: "monitoring_off" })
    );
    expect(
      await screen.findByText(/Needs attention · Remote monitoring is off/)
    ).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledTimes(2);
  } finally {
    await unmount();
    transport.dispose();
  }
});
