import { Laptop, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useRouteError } from "react-router";
import { ErrorStateCard } from "~/components/error-state-card";
import { Button } from "~/components/ui/button";
import { useHostSelection } from "~/lib/host-selection";
import { useTransport } from "~/lib/transport-context";
import { cn } from "~/lib/utils";
import { version } from "../../../package.json";

function routeErrorSummary(
  hostName: string | undefined,
  compact: boolean
): string {
  const lead = hostName
    ? `StatGlass couldn’t display this view for ${hostName}.`
    : "StatGlass couldn’t display this view.";
  return compact
    ? `${lead} Try again.`
    : `${lead} Try again, or open Hosts to choose another machine.`;
}

/** Unexpected render failures stay local to the view, with a way back out. */
export function RouteError({ embedded = false }: { embedded?: boolean }) {
  const error = useRouteError();
  const location = useLocation();
  const navigate = useNavigate();
  const transport = useTransport();
  const selection = useHostSelection();
  const host = selection?.hosts.find((h) => h.id === selection.selected);
  const localHost = selection?.hosts.find((h) => h.is_local);
  const hostId = host?.id;
  const windowLabel = transport.windowLabel();
  const compact = windowLabel === "popover" || windowLabel === "onboarding";
  const message = error instanceof Error ? error.message : String(error);

  useEffect(() => {
    console.error("[route] render error", {
      path: location.pathname,
      hostId,
      window: windowLabel,
      error,
    });
  }, [error, location.pathname, hostId, windowLabel]);

  const diagnostics = [
    `Error: ${message}`,
    `View: ${location.pathname}`,
    ...(hostId ? [`Host: ${hostId}`] : []),
    `Window: ${windowLabel}`,
    `StatGlass: ${version}`,
  ].join("\n");

  const actions = (
    <>
      <Button
        size="sm"
        onClick={() =>
          void navigate(location.pathname + location.search, {
            replace: true,
          })
        }
      >
        <RefreshCw aria-hidden className="size-3.5" />
        Try again
      </Button>
      {!compact && host && !host.is_local && localHost && selection && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            selection.select(localHost.id);
            void navigate("/dashboard/overview");
          }}
        >
          <Laptop aria-hidden className="size-3.5" />
          Switch to This Mac
        </Button>
      )}
      {!compact && (
        <Button size="sm" variant="outline" asChild>
          <Link to="/dashboard/hosts">Open Hosts</Link>
        </Button>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "flex flex-col bg-background text-foreground",
        embedded
          ? "py-6"
          : compact
            ? "min-h-svh justify-center p-3"
            : "min-h-svh justify-center p-8"
      )}
    >
      <ErrorStateCard
        variant="focal"
        compact={compact}
        tone="destructive"
        headingAs="h1"
        titleId="view-error-title"
        title="This view hit a snag"
        meta={
          host
            ? `${host.is_local ? "This Mac" : host.display_name} · ${location.pathname}`
            : location.pathname
        }
        summary={routeErrorSummary(host?.display_name, compact)}
        gifTheme="server-error"
        gifSeed={`${location.pathname}:${message}`}
        actions={actions}
        details={
          <>
            <p className="m-0">{message}</p>
            <p className="m-0">View: {location.pathname}</p>
            {hostId && <p className="m-0">Host: {hostId}</p>}
            <p className="m-0">Window: {windowLabel}</p>
          </>
        }
        copyText={diagnostics}
      />
    </div>
  );
}
