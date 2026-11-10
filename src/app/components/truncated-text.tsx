import { type ReactElement, type ReactNode, useState } from "react";
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
  focusable?: boolean;
  /** Wrap the text in its interactive ancestor, which becomes the tooltip trigger. */
  children?: (text: ReactNode) => ReactElement;
}

/** One ellipsized line; interactive parents can own its tooltip and tab stop. */
export function TruncatedText({
  text,
  className,
  as: Text = "span",
  focusable = true,
  children,
}: TruncatedTextProps) {
  const { ref, isTruncated } = useIsTruncated(text);
  const [open, setOpen] = useState(false);
  const label = (
    <Text
      ref={ref}
      className={cn(
        "block truncate",
        isTruncated &&
          focusable &&
          "rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className
      )}
      tabIndex={isTruncated && focusable ? 0 : undefined}
    >
      {text}
    </Text>
  );
  return (
    <Tooltip open={isTruncated && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        {children ? children(label) : label}
      </TooltipTrigger>
      <TooltipContent className="break-words">{text}</TooltipContent>
    </Tooltip>
  );
}
