import type { CardDensity } from "@core/generated/bindings";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useTransport } from "~/lib/transport-context";

export function PopoverOptions({
  setAll,
}: {
  setAll: (density: CardDensity) => void;
}) {
  const transport = useTransport();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Popover options">
          <SlidersHorizontal strokeWidth={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem onSelect={() => setAll("compact")}>
          Collapse all
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setAll("expanded")}>
          Expand all
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void transport.openDashboard("/dashboard/settings")}
        >
          Open settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
