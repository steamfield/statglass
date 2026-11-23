/**
 * One row of the "Send to" panel: a destination, its last delivery, its
 * switch, "Send test" and its edit button.
 */
import type { DestinationView } from "@core/generated/bindings";
import type { ReactNode } from "react";

/** Props of `DestinationRow`. */
export interface DestinationRowProps {
  /** The destination and its last delivery, as the view holds them. */
  row: DestinationView;
  /** Opens the dialog on this destination ("Edit <name>"). */
  onEdit: () => void;
}

/**
 * A `SettingsRow` labelled with the destination's name; its sub line is the
 * kind ("ntfy", "Webhook") and `destinationAddress`, then `deliveryLabel`
 * of the last delivery ("Delivered 14:02", "Failed 14:02 · HTTP 403").
 * Controls: a switch named by the destination's name that saves it with
 * `enabled` flipped; "Send test to <name>", which calls the test command,
 * reads "Sending…" and is disabled while in flight and while the
 * destination is switched off, then shows the outcome's `deliveryLabel`;
 * and "Edit <name>".
 *
 * Scaffold placeholder: lane a builds it.
 */
export function DestinationRow({
  row,
  onEdit,
}: DestinationRowProps): ReactNode {
  void onEdit;
  return <div>{row.destination.name}</div>;
}
