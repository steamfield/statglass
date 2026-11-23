/**
 * The Alerts page's "Send to" panel: where a fired alert goes besides the
 * Timeline (plan/rfc-alerts.md section 5).
 */
import type { ReactNode } from "react";
import { SettingsPanel } from "~/components/settings-row";

/**
 * A `SettingsPanel` titled "Send to". A fixed first row, "Notifications on
 * this Mac", then one `DestinationRow` per destination from
 * `useAlertDestinations`, then an "Add destination" button that opens
 * `DestinationDialog` on `newDestination("ntfy", <new id>)`. A row's
 * "Edit <name>" opens the dialog on that destination. The panel owns the
 * dialog's draft, so the page only places the panel. A `load_error` shows
 * as one inline message and the panel still works; a failed read shows its
 * error, never an empty list.
 *
 * Scaffold placeholder: lane a builds the rows, the button and the dialog
 * state.
 */
export function DestinationsPanel(): ReactNode {
  return <SettingsPanel title="Send to">{null}</SettingsPanel>;
}
