import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * One line of state under a control or inside a card, at secondary-text
 * size. `status` is muted and polite (loading, empty, a result); `error` is
 * destructive and assertive, for failures only; `note` is a standing
 * explanation with an info icon and no live role.
 */
export function InlineMessage({
  tone,
  className,
  children,
}: {
  tone: "status" | "error" | "note";
  /** Layout only (margins, truncation); the type and colour are fixed. */
  className?: string | undefined;
  children: ReactNode;
}) {
  if (tone === "note")
    return (
      <p
        className={cn(
          "m-0 flex items-start gap-2 font-normal text-muted-foreground text-small leading-normal",
          className
        )}
      >
        <Info aria-hidden className="mt-0.5 size-3.5 flex-none" />
        <span>{children}</span>
      </p>
    );
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "font-normal text-small",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
        className
      )}
    >
      {children}
    </p>
  );
}
