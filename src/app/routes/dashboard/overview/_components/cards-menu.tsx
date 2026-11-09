import { LayoutGrid } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type {
  OverviewCardId,
  OverviewItem,
} from "../_hooks/use-overview-cards";

/**
 * The Overview's card picker: one checkbox per card this host can fill. A
 * change saves at once and the menu stays open for the next one.
 */
export function CardsMenu({
  items,
  shown,
  onChange,
}: {
  items: readonly OverviewItem[];
  shown: (id: OverviewCardId) => boolean;
  onChange: (patch: Partial<Record<OverviewCardId, boolean>>) => void;
}) {
  const hidden = items.filter((item) => !shown(item.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Overview cards">
          <LayoutGrid className="icon-light" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {items.map((item) => (
          <DropdownMenuCheckboxItem
            key={item.id}
            checked={shown(item.id)}
            onCheckedChange={(checked) => onChange({ [item.id]: checked })}
            onSelect={(e) => e.preventDefault()}
          >
            {item.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={hidden.length === 0}
          onSelect={() =>
            onChange(Object.fromEntries(hidden.map((item) => [item.id, true])))
          }
        >
          Show all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
