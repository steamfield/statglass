import type { ConfiguredRoute } from "@core/remote-connection";
import { type GifTheme, pickGif } from "@steamfield/ui/gif";
import { Gif } from "@steamfield/ui/react/gif";
import {
  Check,
  Clock,
  Copy,
  Info,
  OctagonAlert,
  ServerOff,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { Component, type CSSProperties, type ReactNode, useMemo } from "react";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useGifPlaybackGate } from "~/lib/motion/gif-motion";
import { cn } from "~/lib/utils";
import cardStyles from "~/widgets/card.module.css";

export type ErrorStateTone = "info" | "warning" | "destructive";
export type ErrorStateVariant = "banner" | "focal";

export interface ErrorStateCardProps {
  readonly variant?: ErrorStateVariant;
  readonly tone?: ErrorStateTone;
  readonly title: string;
  readonly headingAs?: "h1" | "h2";
  readonly titleId?: string;
  readonly summary: ReactNode;
  /** Factual status line beside/below the title (e.g. "Saved history through … · Auto-retrying"). */
  readonly meta?: ReactNode;
  /** Configured SSH routes shown as compact factual chips. */
  readonly routes?: readonly ConfiguredRoute[];
  /** Contextual `@steamfield/ui/gif` theme; ignored when `compact` is true. */
  readonly gifTheme?: GifTheme | null;
  /** Deterministic seed for `pickGif`, preventing flicker across 1 Hz updates. */
  readonly gifSeed?: string;
  /** Explicit clip URL (`.mp4`, `.webm`, `.webp`, `.gif`), overriding `gifTheme`. */
  readonly gifSrc?: string;
  /** Compact mode for narrow surfaces like the 360 px popover (omits GIF tile). */
  readonly compact?: boolean;
  readonly actions?: ReactNode;
  readonly inlineError?: string | null;
  /** Expandable technical details content (e.g. raw SSH stderr or error stack). */
  readonly details?: ReactNode;
  /** Plain text written by the "Copy details" button inside Technical details. */
  readonly copyText?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
}

class MediaSafetyBoundary extends Component<
  { readonly fallback: ReactNode; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ToneIcon({
  tone,
  className,
}: {
  tone: ErrorStateTone;
  className?: string;
}) {
  if (tone === "destructive") {
    return (
      <OctagonAlert
        aria-hidden
        className={cn("icon-regular shrink-0 text-destructive", className)}
      />
    );
  }
  if (tone === "warning") {
    return (
      <TriangleAlert
        aria-hidden
        className={cn("icon-regular shrink-0 text-warning-ink", className)}
      />
    );
  }
  return (
    <Info
      aria-hidden
      className={cn("icon-regular shrink-0 text-muted-foreground", className)}
    />
  );
}

function OfflineMediaFallback({
  theme,
  tone,
  large,
}: {
  theme: GifTheme | null | undefined;
  tone: ErrorStateTone;
  large: boolean;
}) {
  const iconClass = cn(
    "icon-light",
    large ? "size-7" : "size-5",
    tone === "destructive"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning-ink"
        : "text-muted-foreground"
  );
  let glyph: ReactNode;
  switch (theme) {
    case "network-error":
      glyph = <WifiOff aria-hidden className={iconClass} />;
      break;
    case "timeout":
      glyph = <Clock aria-hidden className={iconClass} />;
      break;
    case "overloaded":
    case "server-error":
      glyph = <ServerOff aria-hidden className={iconClass} />;
      break;
    default:
      glyph = <ToneIcon tone={tone} className={large ? "size-7" : "size-5"} />;
      break;
  }
  return (
    <div
      data-testid="error-media-fallback"
      className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-well text-muted-foreground"
    >
      {glyph}
    </div>
  );
}

function accentVar(tone: ErrorStateTone): string {
  if (tone === "destructive") return "var(--color-destructive)";
  if (tone === "warning") return "var(--color-warning)";
  return "var(--color-cpu)";
}

function ErrorStateDetails({
  details,
  copyText,
}: {
  details: ReactNode;
  copyText?: string;
}) {
  const clipboard = useCopyToClipboard("error-state");
  const copyMessage =
    clipboard.status === "copied"
      ? "Copied to clipboard."
      : clipboard.status === "failed"
        ? "Couldn’t copy to clipboard."
        : "No credentials or keys included.";
  return (
    <details className="text-muted-foreground text-small">
      <summary className="w-fit cursor-pointer rounded-chip outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Technical details
      </summary>
      <div className="mt-2 flex flex-col gap-2 rounded-control border border-border-subtle bg-well p-3">
        <div className="wrap-anywhere select-text space-y-1 text-fg-subtle text-small">
          {details}
        </div>
        {copyText && (
          <div className="flex items-center justify-between gap-2 border-border-subtle border-t pt-2">
            <span className="text-label text-muted-foreground">
              {copyMessage}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void clipboard.copy(copyText)}
            >
              {clipboard.status === "copied" ? (
                <Check aria-hidden className="size-3.5" />
              ) : (
                <Copy aria-hidden className="size-3.5" />
              )}
              {clipboard.status === "copied" ? "Copied" : "Copy details"}
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

function ErrorStateRoutes({ routes }: { routes: readonly ConfiguredRoute[] }) {
  return (
    <ul
      aria-label="Configured routes"
      className="m-0 flex list-none flex-wrap gap-1.5 p-0"
    >
      {routes.map((route) => (
        <li
          key={`${route.kind}:${route.alias}`}
          className="inline-flex items-center gap-1.5 rounded-chip border border-border-subtle bg-well px-2 py-0.5 text-label text-muted-foreground"
        >
          <span className="font-medium text-fg-subtle">{route.label}</span>
          <span className="truncate">{route.alias}</span>
        </li>
      ))}
    </ul>
  );
}

function cardLayoutClass(focal: boolean, compact: boolean): string {
  if (!focal) {
    return "flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4";
  }
  return compact
    ? "flex flex-col gap-3.5 p-4"
    : "mx-auto my-8 flex w-full max-w-[720px] flex-col gap-5 p-6 sm:flex-row sm:items-start sm:gap-6";
}

/**
 * Shared StatGlass error and disconnection surface. Follows `design-system.md`
 * (card surface, subtle corner glow, status icon + word, SF type tokens) and
 * `ce:handling-errors` (what happened, why, concrete recovery actions, and
 * collapsible technical details with one-click copy).
 */
export function ErrorStateCard({
  variant = "banner",
  tone = "warning",
  title,
  headingAs = "h2",
  titleId,
  summary,
  meta,
  routes,
  gifTheme,
  gifSeed,
  gifSrc,
  compact = false,
  actions,
  inlineError,
  details,
  copyText,
  ariaLabel,
  className,
}: ErrorStateCardProps) {
  const resolvedSrc = useMemo(() => {
    if (gifSrc) return gifSrc;
    return gifTheme
      ? pickGif(gifTheme, { seed: gifSeed ?? gifTheme })
      : undefined;
  }, [gifSrc, gifTheme, gifSeed]);

  const showMedia = !compact && Boolean(resolvedSrc);
  const { motion, active } = useGifPlaybackGate(showMedia);
  const focal = variant === "focal";
  const Heading = headingAs;
  const mediaFallback = (
    <OfflineMediaFallback theme={gifTheme} tone={tone} large={focal} />
  );
  const glowStyle = {
    "--a": accentVar(tone),
    "--o": "0% 0%",
  } as CSSProperties;

  return (
    <section
      aria-label={titleId ? undefined : (ariaLabel ?? title)}
      aria-labelledby={titleId}
      data-variant="chart"
      style={glowStyle}
      className={cn(
        cardStyles.card,
        "rounded-card border border-border text-foreground",
        cardLayoutClass(focal, compact),
        className
      )}
    >
      {showMedia && resolvedSrc && (
        <div
          className={cn(
            "shrink-0 overflow-hidden rounded-tile border border-border-subtle bg-well",
            focal
              ? "h-[156px] w-full sm:h-[164px] sm:w-[220px]"
              : "hidden h-[104px] w-[156px] sm:block"
          )}
        >
          <MediaSafetyBoundary key={resolvedSrc} fallback={mediaFallback}>
            <Gif
              src={resolvedSrc}
              motion={motion}
              active={active}
              reducedBehavior="pause"
              fallback={mediaFallback}
              className="h-full w-full rounded-tile bg-well"
              videoClassName="h-full w-full object-cover"
            />
          </MediaSafetyBoundary>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <div role="status" className="flex flex-wrap items-center gap-2">
            <ToneIcon tone={tone} className={focal ? "size-4" : "size-3.5"} />
            <Heading
              id={titleId}
              className={cn(
                "m-0 font-semibold",
                focal ? "text-title tracking-title" : "text-heading"
              )}
            >
              {title}
            </Heading>
          </div>
          {meta && (
            <p className="figures m-0 font-normal text-label text-muted-foreground">
              {meta}
            </p>
          )}
          <p
            className={cn(
              "m-0 font-normal text-fg-subtle leading-normal",
              focal ? "text-body" : "text-small"
            )}
          >
            {summary}
          </p>
        </div>

        {routes && routes.length > 0 && <ErrorStateRoutes routes={routes} />}

        {actions && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {actions}
          </div>
        )}

        {inlineError && (
          <InlineMessage tone="error">{inlineError}</InlineMessage>
        )}

        {details && (
          <ErrorStateDetails
            details={details}
            {...(copyText ? { copyText } : {})}
          />
        )}
      </div>
    </section>
  );
}
