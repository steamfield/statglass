import { OctagonAlert, TriangleAlert } from "lucide-react";
import { cn } from "~/lib/utils";

export interface AlertChipProps {
  tone: "warn" | "critical";
  text: string;
  size?: "label" | "small";
  iconOnly?: boolean;
}

export function AlertChip({
  tone,
  text,
  size = "label",
  iconOnly = false,
}: AlertChipProps) {
  const Icon = tone === "warn" ? TriangleAlert : OctagonAlert;
  return (
    <span
      aria-hidden={iconOnly || undefined}
      className={cn(
        "inline-flex items-center gap-1 self-center",
        iconOnly && "shrink-0",
        size === "small" ? "text-small" : "text-label",
        tone === "warn" ? "text-warning" : "text-destructive"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          !iconOnly && "icon-regular",
          size === "small" ? "size-3.5" : "size-3"
        )}
      />
      {!iconOnly && text}
    </span>
  );
}
