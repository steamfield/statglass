import type { RemoteHostRecord } from "@core/generated/bindings";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { RangeNavigationProvider } from "~/hooks/use-range-navigation";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import {
  DashboardShellContext,
  type DashboardShellState,
} from "~/lib/dashboard-shell";
import { HostClockContext } from "~/lib/host-clock";
import { useHostSelection } from "~/lib/host-selection";
import { usePageEntrance } from "~/lib/motion/page-entrance";
import { useTransport } from "~/lib/transport-context";
import { HostStoreProvider, useHostId } from "~/stores/host-store";
import { useSampling } from "~/stores/live-selectors";
import { HostConnectionNotice } from "./_components/host-connection-notice";
import { HostUpdateNotice } from "./_components/host-update-notice";
import { LiveSidebar } from "./_components/live-sidebar";
import { StarPromptHost } from "./_components/star-prompt-host";

/**
 * An open dashboard window follows `navigate-requested`: Rust sends it when
 * the popover or tray asks for a route (Settings, Activity) while the window
 * already exists. Only `/dashboard/...` routes are accepted.
 */
function useNavigateRequests() {
  const transport = useTransport();
  const navigate = useNavigate();
  useEffect(
    () =>
      transport.onNavigateRequested(({ route }) => {
        if (route === "/dashboard" || route.startsWith("/dashboard/")) {
          void navigate(route);
        } else {
          console.warn("[dashboard] ignored navigate-requested", { route });
        }
      }),
    [transport, navigate]
  );
}

/**
 * The page scrolls inside `<main>`, which outlives route changes, so a new
 * page would otherwise open at the previous page's offset. Reset before paint.
 */
function useScrollTopOnNavigate(ref: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [pathname, ref]);
}

const localNow = () => Date.now();
function selectConnection(hosts: RemoteHostRecord[]) {
  return hosts.map((host) => ({
    config: host.config,
    os: host.os,
    status: {
      state: host.status.state,
      route: host.status.route,
      error: host.status.error,
      failure_kind: host.status.failure_kind,
      synced_through_ms: host.status.synced_through_ms,
      identity_changed: host.status.identity_changed,
      agent_update: host.status.agent_update,
    },
  }));
}

/** The notice also reads sync, last_seen, and clock facts; keep that subscription local. */
function ConnectionNotice({
  id,
  variant,
}: {
  id: string;
  variant: "banner" | "focal";
}) {
  const remote = useRemoteHosts((hosts) =>
    hosts.find((host) => host.config.id === id)
  ).data;
  return remote ? (
    <HostConnectionNotice remote={remote} variant={variant} />
  ) : null;
}

/**
 * Dashboard window shell (plan 4.4): the 220 px sidebar under the overlay
 * title bar, and the scrolling page. Banners and focal remote-connection
 * states are provided through `DashboardShellContext` so each route's sticky
 * `PageHeader` stays pinned at `top: 0` aligned with the sidebar brand row
 * and never dims under `stale`.
 */
export default function DashboardLayout() {
  useNavigateRequests();
  const mainRef = useRef<HTMLElement>(null);
  useScrollTopOnNavigate(mainRef);
  const sampling = useSampling();
  const hostId = useHostId();
  const local = useHostSelection()?.hosts.find((host) => host.is_local);
  const remote = useRemoteHosts(selectConnection).data?.find(
    (host) => host.config.id === hostId
  );
  const { pathname, search } = useLocation();
  // Hosts, Settings and Alerts belong to This Mac: they render in its store
  // and on its clock whichever host is selected.
  const metricPage =
    pathname !== "/dashboard/hosts" &&
    pathname !== "/dashboard/settings" &&
    pathname !== "/dashboard/alerts";
  const hasRemote = remote !== undefined;
  const remoteDisconnected = hasRemote && remote.status.state !== "connected";
  const view = new URLSearchParams(search).get("view");
  const isDiskSpace = pathname === "/dashboard/disk" && view === "space";

  const liveOnlyPage =
    pathname === "/dashboard/processes" ||
    pathname === "/dashboard/containers" ||
    isDiskSpace;
  const useFocal =
    metricPage &&
    remoteDisconnected &&
    (remote.status.synced_through_ms === null || liveOnlyPage);
  // A page opens on a new route, Disk's I/O and Space views, or another host
  // on a metric page (Settings, Hosts and Alerts show This Mac's whichever is
  // selected). Range, filter and Containers' view params keep the same
  // header and controls in place, so they never replay it.
  const pageRef = usePageEntrance<HTMLDivElement>(
    `${metricPage ? hostId : ""}|${pathname}|${isDiskSpace ? "space" : ""}`
  );
  const stale =
    metricPage && ((sampling.stale && !sampling.paused) || remoteDisconnected);
  // Keep readable mirrored history crisp when a remote host is disconnected;
  // dim only live streams that went stale without a disconnect card explaining it.
  const dimBody =
    metricPage && sampling.stale && !sampling.paused && !remoteDisconnected;

  const shell = useMemo<DashboardShellState>(
    () => ({
      banners: metricPage ? (
        <>
          <HostUpdateNotice />
          {hasRemote && !useFocal && (
            <ConnectionNotice key={hostId} id={hostId} variant="banner" />
          )}
        </>
      ) : null,
      focalNotice:
        hasRemote && useFocal ? (
          <ConnectionNotice key={hostId} id={hostId} variant="focal" />
        ) : null,
      dimBody,
    }),
    [metricPage, hasRemote, useFocal, hostId, dimBody]
  );

  return (
    <RangeNavigationProvider>
      <div className="flex h-svh bg-background text-foreground">
        <LiveSidebar />
        <main
          ref={mainRef}
          data-stale={stale || undefined}
          className="min-w-0 flex-1 overflow-y-auto px-3 pb-6 sm:px-6"
        >
          <DashboardShellContext.Provider value={shell}>
            <div ref={pageRef}>
              {!metricPage && local && local.id !== hostId ? (
                <HostClockContext.Provider value={localNow}>
                  <HostStoreProvider hostId={local.id}>
                    <Outlet />
                  </HostStoreProvider>
                </HostClockContext.Provider>
              ) : (
                <Outlet />
              )}
            </div>
          </DashboardShellContext.Provider>
        </main>
        <StarPromptHost hasFocalNotice={useFocal} />
      </div>
    </RangeNavigationProvider>
  );
}
