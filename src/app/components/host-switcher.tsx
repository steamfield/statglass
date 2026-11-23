import { Monitor } from "lucide-react";
import { memo } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useHostSelection } from "~/lib/host-selection";

// Host selection follows its own context; metric-only sidebar updates do not
// need to rebuild the closed selection menu on every sample.
export const HostSwitcher = memo(function HostSwitcher() {
  const selection = useHostSelection();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!selection) return null;
  return (
    <div className="px-1 pb-3 max-sm:px-0">
      <Select
        value={selection.selected}
        onValueChange={(id) => {
          selection.select(id);
          if (
            pathname === "/dashboard/hosts" ||
            pathname === "/dashboard/settings"
          )
            void navigate("/dashboard/overview");
        }}
      >
        <SelectTrigger
          aria-label="Selected machine"
          title={
            selection.hosts.find((host) => host.id === selection.selected)
              ?.display_name
          }
          size="sm"
          className="w-full text-small max-sm:justify-center max-sm:px-0 max-sm:[&>svg:last-child]:hidden"
        >
          <Monitor aria-hidden className="hidden size-4 max-sm:block" />
          <span className="min-w-0 truncate max-sm:sr-only">
            <SelectValue />
          </span>
        </SelectTrigger>
        {/* Below the trigger, like a menu: the default item-aligned position
            lays the selected host over the trigger, which lifts a long list
            into the logo. */}
        <SelectContent position="popper" side="bottom" align="start">
          {selection.hosts.map((host) => (
            <SelectItem key={host.id} value={host.id}>
              {host.is_local ? "This Mac" : host.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
});
