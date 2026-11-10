import { OctagonAlert, TriangleAlert } from "lucide-react";
import { cn } from "~/lib/utils";

export interface AlertChipProps {
  tone: "warn" | "critical";
  text: string;
}

export function AlertChip({ tone, text }: AlertChipProps) {
  const Icon = tone === "warn" ? TriangleAlert : OctagonAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 self-center text-label",
        tone === "warn" ? "text-warning" : "text-destructive"
      )}
    >
      <Icon aria-hidden className="icon-regular size-3" />
      {text}
    </span>
  );
}
