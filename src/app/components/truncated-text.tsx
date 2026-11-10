import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useIsTruncated } from "~/hooks/use-is-truncated";
import { cn } from "~/lib/utils";

export interface TruncatedTextProps {
  text: string;
  className?: string;
  as?: "span" | "p";
}

/**
 * One line of text that ends in an ellipsis when it doesn't fit. Only then is it
 * a tab stop with a tooltip holding the full text; the text stays in the DOM, so
 * screen readers get it either way. The tooltip always wraps the element, so it
 * is never replaced when the width changes and keeps focus.
 */
export function TruncatedText({
  text,
  className,
  as: Text = "span",
}: TruncatedTextProps) {
  const { ref, isTruncated } = useIsTruncated(text);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={isTruncated && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Text
          ref={ref}
          className={cn(
            "block truncate",
            isTruncated &&
              "rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            className
          )}
          tabIndex={isTruncated ? 0 : undefined}
        >
          {text}
        </Text>
      </TooltipTrigger>
      <TooltipContent className="break-words">{text}</TooltipContent>
    </Tooltip>
  );
}
