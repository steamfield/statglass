import { memo } from "react";
import { SearchField } from "~/components/search-field";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { lifecycleLabel } from "../_lib/presentation";

function ContainerFiltersView({
  query,
  state,
  grouped,
  columns,
  set,
}: {
  query: string;
  state: string;
  grouped: boolean;
  columns: string[];
  set: (key: string, value: string | null) => void;
}) {
  return (
    <>
      <SearchField
        value={query}
        onChange={(value) => set("q", value || null)}
        placeholder="Search containers…"
        label="Search containers by name, image or project"
      />
      <Select
        value={state}
        onValueChange={(value) => set("state", value === "all" ? null : value)}
      >
        <SelectTrigger aria-label="Container state" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All states</SelectItem>
          {Object.entries(lifecycleLabel).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            View
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-40">
          <DropdownMenuCheckboxItem
            checked={grouped}
            onCheckedChange={(value) => set("group", value ? "grouped" : null)}
          >
            Group by project
          </DropdownMenuCheckboxItem>
          {[
            ["io", "Block I/O"],
            ["image", "Image"],
            ["ports", "Ports"],
            ["restarts", "Restarts"],
            ["pids", "PIDs"],
          ].map(([value, label]) => (
            <DropdownMenuCheckboxItem
              key={value}
              checked={columns.includes(value ?? "")}
              onCheckedChange={(checked) =>
                set(
                  "columns",
                  (checked
                    ? [...columns, value]
                    : columns.filter((c) => c !== value)
                  ).join(",") || null
                )
              }
            >
              {label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export const ContainerFilters = memo(
  ContainerFiltersView,
  (previous, next) =>
    previous.query === next.query &&
    previous.state === next.state &&
    previous.grouped === next.grouped &&
    previous.set === next.set &&
    previous.columns.length === next.columns.length &&
    previous.columns.every((column, index) => column === next.columns[index])
);
