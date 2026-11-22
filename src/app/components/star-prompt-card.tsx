/**
 * Non-modal bottom-right hover-card prompting engaged users to star StatGlass on GitHub.
 */
import { Star, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "~/components/ui/button";
import { enter } from "~/lib/motion/enter";
import { cn } from "~/lib/utils";

/** Props for the GitHub star prompt card. */
export interface StarPromptCardProps {
  canSnooze: boolean;
  onStar: () => void;
  onSnooze: () => void;
  onDismiss: () => void;
  className?: string;
}

const CARD_SURFACE =
  "rounded-card border border-border bg-popover p-4 text-popover-foreground shadow-md dark:shadow-none";

function StarPromptHeader({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Star aria-hidden className="icon-regular size-4 shrink-0 text-power" />
        <p className="font-semibold text-body text-foreground">
          Enjoying StatGlass?
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0"
      >
        <X aria-hidden className="icon-regular size-3.5" />
      </Button>
    </div>
  );
}

function StarPromptActions({
  canSnooze,
  onStar,
  onSnooze,
  onDismiss,
}: Omit<StarPromptCardProps, "className">) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <Button type="button" size="sm" onClick={onStar}>
        Star on GitHub
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={canSnooze ? onSnooze : onDismiss}
      >
        {canSnooze ? "Not now" : "Don't ask again"}
      </Button>
    </div>
  );
}

/** Renders a calm, non-modal card inviting the user to star StatGlass on GitHub. */
export function StarPromptCard({
  canSnooze,
  onStar,
  onSnooze,
  onDismiss,
  className,
}: StarPromptCardProps) {
  const entrance = enter(0, "lift");

  function dismissOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") {
      return;
    }
    event.stopPropagation();
    onDismiss();
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: captures bubbled Escape from focused buttons inside the card
    <aside
      role="status"
      aria-label="Star StatGlass on GitHub"
      onKeyDown={dismissOnEscape}
      style={entrance.style}
      className={cn(CARD_SURFACE, entrance.className, className)}
    >
      <StarPromptHeader onDismiss={onDismiss} />
      <p className="mt-1.5 font-normal text-muted-foreground text-small">
        StatGlass is free and open source. A star on GitHub helps others
        discover it.
      </p>
      <StarPromptActions
        canSnooze={canSnooze}
        onStar={onStar}
        onSnooze={onSnooze}
        onDismiss={onDismiss}
      />
    </aside>
  );
}
