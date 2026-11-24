import { windowEnding } from "@core/chart-range";
import type { RemoteHostRecord } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import {
  remoteConnectionView,
  retryScheduleText,
} from "@core/remote-connection";
import { remoteErrorText } from "@core/remote-errors";
import { connectionLabel } from "@core/remote-hosts";
import { DAY_MS, MINUTE_MS } from "@core/time-grid";
import { useQueryClient } from "@tanstack/react-query";
import { History, Laptop, Power, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ErrorStateCard,
  type ErrorStateVariant,
} from "~/components/error-state-card";
import { Button } from "~/components/ui/button";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useSecondsUntil } from "~/hooks/use-seconds-until";
import { useHostSelection } from "~/lib/host-selection";
import { useTransport } from "~/lib/transport-context";

/** Local wall clock matching Rust's `last_seen_ms` epoch, ticking only when needed. */
function useLocalMinuteNow(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [active]);
  return nowMs;
}

/** The notice's meta line with the retry countdown appended, ticking on its own each second. */
function RetryMeta({
  fact,
  dialing,
  nextAttemptMs,
}: {
  fact: string;
  dialing: boolean;
  nextAttemptMs: number | null;
}) {
  const seconds = useSecondsUntil(dialing ? null : nextAttemptMs);
  const schedule = retryScheduleText(dialing, seconds);
  return <>{[fact, schedule].filter(Boolean).join(" · ")}</>;
}

/** Retry connection, disabled and reading "Trying…" while an attempt is in flight. */
function RetryButton({
  primary,
  trying,
  onRetry,
}: {
  primary: boolean;
  trying: boolean;
  onRetry: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={trying}
      onClick={onRetry}
    >
      <RefreshCw aria-hidden className="size-3.5" />
      {trying ? "Trying…" : "Retry connection"}
    </Button>
  );
}

/**
 * Connection failures are recoverable states, not render errors.
 * Adapts between a compact `banner` (when mirrored history is available below)
 * and a dominant `focal` state (when no saved history exists or the page is live-only).
 */
export function HostConnectionNotice({
  remote,
  variant = "banner",
}: {
  remote: RemoteHostRecord;
  variant?: ErrorStateVariant;
}) {
  const transport = useTransport();
  const cache = useQueryClient();
  const selection = useHostSelection();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const rangeNav = useRangeNavigation();
  const { status, config } = remote;
  const connected = status.state === "connected";
  const nowMs = useLocalMinuteNow(!connected && status.last_seen_ms !== null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const localHost = selection?.hosts.find((host) => host.is_local);

  if (connected) {
    return (
      <p
        role="status"
        className="m-0 border-border-subtle border-b pb-2.5 text-muted-foreground text-small"
      >
        {config.name} · {connectionLabel(remote)}
        {Math.abs(status.clock_offset_ms ?? 0) >= 30000 &&
          " · chart times follow this Mac’s clock"}
      </p>
    );
  }

  const view = remoteConnectionView(remote, nowMs);

  const retry = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await transport.retryRemoteHost(config.id);
      if (result.status === "error") {
        setActionError(remoteErrorText(result.error));
      }
      await cache.invalidateQueries({ queryKey: hostKeys.remote() });
    } catch (error) {
      console.error("[remote] retry failed", { hostId: config.id, error });
      setActionError("The retry couldn’t be started. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const enableHost = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await transport.updateRemoteHost({
        ...config,
        enabled: true,
      });
      if (result.status === "error") {
        setActionError(remoteErrorText(result.error));
      }
      await cache.invalidateQueries({ queryKey: hostKeys.remote() });
    } catch (error) {
      console.error("[remote] enable failed", { hostId: config.id, error });
      setActionError("Couldn’t turn connection back on. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const jumpToHistory = () => {
    if (view.syncedThroughMs === null) return;
    void rangeNav.apply(windowEnding(view.syncedThroughMs, DAY_MS));
    void navigate("/dashboard/timeline");
  };

  const showHistoryJump =
    view.syncedThroughMs !== null && pathname !== "/dashboard/timeline";

  const actions = (
    <>
      {view.primaryAction === "enable" && (
        <Button size="sm" disabled={busy} onClick={() => void enableHost()}>
          <Power aria-hidden className="size-3.5" />
          {busy ? "Turning on…" : "Turn on connection"}
        </Button>
      )}
      {view.showRetry && (
        <RetryButton
          primary={view.primaryAction === "retry"}
          trying={busy || view.dialing}
          onRetry={() => void retry()}
        />
      )}
      {showHistoryJump && (
        <Button size="sm" variant="outline" onClick={jumpToHistory}>
          <History aria-hidden className="size-3.5" />
          Jump to saved history
        </Button>
      )}
      {localHost && selection && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => selection.select(localHost.id)}
        >
          <Laptop aria-hidden className="size-3.5" />
          Switch to This Mac
        </Button>
      )}
      <Button
        size="sm"
        variant={view.primaryAction === "open_hosts" ? "default" : "ghost"}
        asChild
      >
        <Link to="/dashboard/hosts">Open Hosts</Link>
      </Button>
    </>
  );

  return (
    <ErrorStateCard
      variant={variant}
      tone={view.tone}
      title={view.title}
      meta={
        <RetryMeta
          fact={view.meta}
          dialing={view.dialing}
          nextAttemptMs={view.nextAttemptMs}
        />
      }
      summary={view.summary}
      routes={view.routes}
      gifTheme={view.gifTheme}
      gifSeed={view.gifSeed}
      actions={actions}
      inlineError={actionError}
      details={status.error ? <p className="m-0">{status.error}</p> : undefined}
      copyText={view.diagnostics}
      ariaLabel="Host connection"
    />
  );
}
