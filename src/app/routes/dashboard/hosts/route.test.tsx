import type { RemoteState } from "@core/generated/bindings";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { hostKeys } from "@core/query-keys";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import * as React from "react";
import { Profiler } from "react";
import { HostSelectionContext } from "~/lib/host-selection";
import { useHostStore } from "~/stores/host-store";
import { LocalHostCard, RemoteHostCard } from "./_components/host-cards";
import HostsRoute from "./route";

// Observe real React calls; application components and hooks stay intact.
vi.mock("react", { spy: true });

const sources: MockTransport[] = [];
afterEach(() => {
  cleanup();
  for (const source of sources.splice(0)) source.dispose();
  vi.useRealTimers();
});

async function mount(
  scenarios: Parameters<typeof createMockTransport>[0] = {}
) {
  const source = createMockTransport({ autoTick: false, ...scenarios });
  sources.push(source);
  const hosts = await source.listHosts();
  const select = vi.fn();
  const view = renderWithProviders(
    <HostSelectionContext.Provider
      value={{ hosts, selected: hosts[0]?.id ?? "", select }}
    >
      <HostsRoute />
    </HostSelectionContext.Provider>,
    { transport: source, route: "/dashboard/hosts" }
  );
  return { ...view, source, select };
}

it("renders a card for every host, and enables a disabled host", async () => {
  const { source } = await mount({ scenarios: ["hosts-dashboard"] });
  await screen.findByRole("region", { name: "studio" });
  expect(screen.getAllByRole("button", { name: "View metrics" })).toHaveLength(
    6
  );
  expect(
    within(screen.getByRole("region", { name: "This Mac" })).getByText("Live")
  ).toBeInTheDocument();
  const offline = within(screen.getByRole("region", { name: "offline" }));
  expect(offline.getByText("Offline")).toBeInTheDocument();
  expect(offline.getByText(/^Last seen /)).toBeInTheDocument();
  fireEvent.click(offline.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(offline.getByText("Live")).toBeInTheDocument());
  const disabled = within(screen.getByRole("region", { name: "studio" }));
  expect(disabled.getByText("Connection off")).toBeInTheDocument();
  fireEvent.click(disabled.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(disabled.getByText("Live")).toBeInTheDocument());
  expect(
    (await source.listRemoteHosts()).find(
      (host) => host.config.name === "studio"
    )?.config.enabled
  ).toBe(true);
  expect(
    source.calls.filter(
      (call) =>
        call.command === "subscribe_live" && call.args[0] !== MOCK_HOST_ID
    )
  ).toHaveLength(0);
});

it("opens all settings sections, saves edits, and preserves removal cancellation", async () => {
  const { source } = await mount({ scenarios: ["hosts-dashboard"] });
  fireEvent.click(
    await screen.findByRole("button", { name: "Settings for studio" })
  );
  const dialog = within(screen.getByRole("dialog"));
  for (const name of [
    "Connection",
    "History on this Mac",
    "Updates on this host",
    "Remove",
  ])
    expect(dialog.getByRole("heading", { name })).toBeInTheDocument();
  expect(
    within(
      dialog.getByRole("region", { name: "Updates on this host" })
    ).queryByRole("button", { name: "Turn on" })
  ).not.toBeInTheDocument();
  fireEvent.change(dialog.getByLabelText("Name"), {
    target: { value: "Renamed studio" },
  });
  fireEvent.change(dialog.getByLabelText("LAN SSH alias"), {
    target: { value: "ssh invalid" },
  });
  expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(dialog.getByLabelText("LAN SSH alias"), {
    target: { value: "studio-new.local" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Remove…" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByLabelText("Name")).toHaveValue("Renamed studio");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  expect((await source.listRemoteHosts())[0]?.config).toMatchObject({
    name: "Renamed studio",
    lan: "studio-new.local",
  });
});

it("opens release notes and offers a failed update retry", async () => {
  const { source } = await mount({
    scenarios: ["host-update-failed", "hosts-outdated"],
  });
  const open = vi.spyOn(source, "openUrl");
  expect(
    await screen.findByRole("button", { name: "Retry update" })
  ).toBeEnabled();
  fireEvent.click(
    within(screen.getByRole("region", { name: "nas" })).getByRole("button", {
      name: "What’s new",
    })
  );
  expect(open).toHaveBeenCalledWith(
    "https://github.com/steamfield/statglass/releases/tag/v0.1.0"
  );
  const offline = within(screen.getByRole("region", { name: "pi" }));
  expect(
    offline.getByText(/available, updates once reachable/)
  ).toBeInTheDocument();
  expect(
    offline.queryByRole("button", { name: /^Update to/ })
  ).not.toBeInTheDocument();
});

it("walks all update phases and exposes upload byte progress until reconnect", async () => {
  vi.useFakeTimers();
  const { source } = await mount({ scenarios: ["host-updating"] });
  await act(() => vi.advanceTimersByTimeAsync(100));
  const card = within(screen.getByRole("region", { name: "updating" }));
  expect(card.getByRole("button", { name: "Updating…" })).toBeDisabled();
  expect(card.getByText(/Waiting for another update/)).toBeInTheDocument();
  expect(card.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  for (const text of [
    "Checking the host",
    "Uploading 0.0 of 8.0 MB",
    "Uploading 4.0 of 8.0 MB",
    "Installing",
    "Restarting",
    "Reconnecting",
  ]) {
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(card.getByText(`Updating to 0.1.0 · ${text}`)).toBeInTheDocument();
    if (text === "Uploading 4.0 of 8.0 MB") {
      expect(card.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "4000000"
      );
      expect(card.getByRole("progressbar")).toHaveAttribute(
        "aria-valuemax",
        "8000000"
      );
    }
  }
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(card.getByText("StatGlass 0.1.0 · Latest")).toBeInTheDocument();
  expect(card.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(
    source.calls.some(
      (call) =>
        call.command === "set_hosts_recent_interest" && call.args[0] === true
    )
  ).toBe(true);
});

it("does not render host B when only host A's status changes", async () => {
  const source = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
  });
  sources.push(source);
  let renders = 0;
  const view = renderWithProviders(
    <>
      <RemoteHostCard id="remote-studio" origin="tl" />
      <Profiler id="B" onRender={() => renders++}>
        <RemoteHostCard id="remote-build" origin="tr" />
      </Profiler>
    </>,
    { transport: source }
  );
  await screen.findByRole("region", { name: "build" });
  await waitFor(() =>
    expect(screen.queryAllByText("Loading recent history…")).toHaveLength(0)
  );
  await act(() =>
    view.queryClient.invalidateQueries({ queryKey: hostKeys.remote() })
  );
  const before = renders;
  act(() => source.pushRemoteStatus("remote-studio", { state: "offline" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "studio" })).getByText(
        "Offline"
      )
    ).toBeInTheDocument()
  );
  expect(renders).toBe(before);
});

it("opens app Settings for This Mac's update", async () => {
  const view = await mount({
    updateStatus: { kind: "available", version: "0.12.0", notes: "" },
  });
  const card = within(await screen.findByRole("region", { name: "This Mac" }));
  expect(card.getByText(/StatGlass .* · 0.12.0 available/)).toBeInTheDocument();
  fireEvent.click(card.getByRole("button", { name: "Update" }));
  expect(view.router.state.location.pathname).toBe("/dashboard/settings");
});

it("reinstalls a Mac through Add host while preserving its identity and mirror budget", async () => {
  const view = await mount({ scenarios: ["hosts-outdated"] });
  const studio = (await view.source.listRemoteHosts()).find(
    (host) => host.config.name === "studio"
  );
  if (!studio) throw new Error("Missing studio fixture");
  await act(() =>
    view.source.updateRemoteHost({ ...studio.config, mirror_budget_mb: 500 })
  );
  await act(() =>
    view.queryClient.invalidateQueries({ queryKey: hostKeys.remote() })
  );
  const before = await view.source.listRemoteHosts();
  fireEvent.click(
    within(await screen.findByRole("region", { name: "studio" })).getByRole(
      "button",
      { name: "Reinstall 0.1.0…" }
    )
  );
  expect(screen.getByLabelText("Name")).toHaveValue("studio");
  for (const name of ["Name", "LAN SSH alias", "Tailscale SSH alias"])
    expect(screen.getByLabelText(name)).toHaveAttribute("readonly");
  expect(
    screen.getByText("Change aliases in this host's settings")
  ).toBeVisible();
  expect(screen.getByLabelText("LAN SSH alias")).toHaveValue("studio.local");
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Reinstall and connect" })
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  expect(
    (await view.source.listRemoteHosts()).map((host) => host.config)
  ).toEqual(before.map((host) => host.config));
  const call = view.source.calls.find(
    (call) => call.command === "add_remote_host"
  );
  expect(call?.args[0]).toMatchObject({
    id: "remote-studio",
    mirror_budget_mb: 500,
  });
  expect(call?.args[1]).toBe(true);
  expect(call?.args[4]).toBe(studio.config.id);
});

it("navigates once from the host name and leaves modified clicks in the current window", async () => {
  const view = await mount({ scenarios: ["multi-host"] });
  const name = within(
    await screen.findByRole("region", { name: "Studio Mac" })
  ).getByRole("link", { name: "Studio Mac" });
  fireEvent.click(name);
  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe("/dashboard/overview")
  );
  await act(() => view.router.navigate(-1));
  expect(view.router.state.location.pathname).toBe("/dashboard/hosts");
  view.select.mockClear();
  fireEvent.click(
    within(screen.getByRole("region", { name: "Studio Mac" })).getByRole(
      "link",
      { name: "Studio Mac" }
    ),
    { ctrlKey: true }
  );
  expect(view.router.state.location.pathname).toBe("/dashboard/hosts");
  expect(view.select).not.toHaveBeenCalled();
});

it("keeps a newer Mac's probe facts and does not request a downgrade from Reinstall", async () => {
  const view = await mount({ scenarios: ["hosts-outdated"] });
  view.source.prepareRemoteHost = async () => ({
    status: "ok",
    data: {
      kind: "mac",
      installed: true,
      compatible: true,
      newer_installed: true,
      host_id: "remote-studio",
      name: "studio",
      message: null,
      linux: null,
    },
  });
  fireEvent.click(
    within(await screen.findByRole("region", { name: "studio" })).getByRole(
      "button",
      { name: "Reinstall 0.1.0…" }
    )
  );
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(
      view.source.calls.some((call) => call.command === "add_remote_host")
    ).toBe(true)
  );
  expect(
    view.source.calls.find((call) => call.command === "add_remote_host")
      ?.args[1]
  ).toBe(false);
});

it("shows shared rr jobs, the local job, and removes a disconnected band", async () => {
  const { source } = await mount({ scenarios: ["rr-jobs"], historyRows: 1 });
  for (const { name, peer } of [
    { name: "rr-build", peer: "rr-test" },
    { name: "rr-test", peer: "rr-build" },
  ]) {
    const card = within(await screen.findByRole("region", { name }));
    expect(card.getByText(`From MacBook Pro · also on ${peer}`)).toBeVisible();
    expect(card.getByText("cargo test --workspace")).toBeVisible();
  }
  const local = within(screen.getByRole("region", { name: "This Mac" }));
  expect(await local.findByText("cargo check --workspace")).toBeVisible();
  act(() => source.pushRemoteStatus("remote-rr-build", { state: "offline" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "rr-build" })).queryByText(
        "rr running"
      )
    ).not.toBeInTheDocument()
  );
});

it("reads the local job once per minute and stops when the card unmounts", async () => {
  vi.useFakeTimers();
  const source = createMockTransport({
    scenarios: ["rr-jobs"],
    autoTick: false,
    historyRows: 1,
  });
  sources.push(source);
  const read = vi.spyOn(source, "localRrJob");
  const hosts = await source.listHosts();
  const view = renderWithProviders(
    <HostSelectionContext.Provider
      value={{ hosts, selected: MOCK_HOST_ID, select: () => {} }}
    >
      <HostsRoute />
    </HostSelectionContext.Provider>,
    { transport: source }
  );
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(59_989));
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(read).toHaveBeenCalledTimes(2);
  view.queryClient.clear();
});

it("counts every non-live state as not connected, with available updates", async () => {
  const view = await mount({
    scenarios: ["hosts-dashboard", "hosts-outdated"],
  });
  await screen.findByRole("region", { name: "studio" });
  const records = await view.source.listRemoteHosts();
  const id = records[0]?.config.id;
  if (!id) throw new Error("Missing remote host");
  const liveOthers =
    records.filter(
      (host) =>
        host.config.id !== id &&
        host.status.state === "connected" &&
        !host.status.identity_changed &&
        host.status.agent_update.kind !== "required"
    ).length + 1;
  const total = records.length + 1;
  const updates = records.filter(
    (host) =>
      host.config.enabled &&
      (host.status.agent_update.kind === "available" ||
        host.status.agent_update.kind === "required")
  ).length;
  const states: RemoteState[] = [
    "error",
    "disabled",
    "connecting",
    "offline",
    "connected",
  ];
  for (const state of states) {
    act(() =>
      view.source.pushRemoteStatus(id, {
        state,
        identity_changed: state === "connected" ? "other-host" : null,
      })
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          `${total} hosts · ${liveOthers} live · ${total - liveOthers} not connected · ${updates} updates available`
        )
      ).toBeVisible()
    );
  }
});

it("commits live local figures without rendering the card body or metric lanes", async () => {
  vi.useFakeTimers();
  const source = createMockTransport({ autoTick: false, historyRows: 1 });
  sources.push(source);
  const hosts = await source.listHosts();
  const host = hosts.find((host) => host.is_local);
  if (!host) throw new Error("Missing local host");
  let store: ReturnType<typeof useHostStore> | undefined;
  function GrabStore() {
    store = useHostStore();
    return null;
  }
  // HostCard and each lane call React.useId; figure leaves do not. Observe
  // the real React hook to count body renders without replacing components.
  const identities = vi.mocked(React.useId);
  identities.mockClear();
  let commits = 0;
  const view = renderWithProviders(
    <HostSelectionContext.Provider
      value={{ hosts, selected: host.id, select: () => {} }}
    >
      <GrabStore />
      <Profiler id="local-card" onRender={() => commits++}>
        <LocalHostCard host={host} origin="tl" target={null} />
      </Profiler>
    </HostSelectionContext.Provider>,
    { transport: source }
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(identities.mock.calls.length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/Loading .*…/)).toHaveLength(0);
  const before = commits;
  identities.mockClear();
  for (const cpu of [91, 92, 93]) {
    if (!store) throw new Error("Missing local store");
    const frame = nextFrame(store.getState(), {
      "cpu.total": cpu,
      "mem.used": cpu * 1_000_000,
    });
    act(() => source.push(frame));
    expect(
      within(screen.getByRole("region", { name: "This Mac" })).getByText(
        `${cpu}%`
      )
    ).toBeVisible();
  }
  expect(commits).toBe(before + 3);
  expect(identities).not.toHaveBeenCalled();
  view.unmount();
  identities.mockClear();
});
