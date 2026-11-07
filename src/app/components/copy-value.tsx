import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";

/**
 * A value that copies itself on click: the tooltip says "Copy" on hover and
 * "Copied" once the clipboard has it ("Couldn't copy" if it refused).
 */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const { status: state, copy } = useCopyToClipboard(`copy-value ${label}`);
  const [hover, setHover] = useState(false);

  return (
    <Tooltip
      open={state !== "idle" || hover}
      onOpenChange={(open) => setHover(open)}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copy(value)}
          aria-label={`Copy ${label} ${value}`}
          className="figures -mx-1 rounded-sm px-1 text-fg-subtle outline-none hover:bg-selected hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <span aria-live="polite">
          {state === "copied"
            ? "Copied"
            : state === "failed"
              ? "Couldn't copy"
              : "Copy"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
