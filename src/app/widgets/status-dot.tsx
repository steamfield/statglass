import { Pause } from "lucide-react";
import { cn } from "~/lib/utils";

export interface StatusDotProps {
  state: "live" | "idle" | "paused" | "stale";
  className?: string;
}

/** Decorative state mark; the caller supplies the state word. */
export function StatusDot({ state, className }: StatusDotProps) {
  if (state === "paused") {
    return (
      <Pause aria-hidden className={cn("icon-bold size-2.5", className)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 rounded-full",
        state === "live"
          ? "bg-live"
          : state === "idle"
            ? "bg-fg-faint"
            : "border border-muted-foreground bg-transparent",
        className
      )}
    />
  );
}
