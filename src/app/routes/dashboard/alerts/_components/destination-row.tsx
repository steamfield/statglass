/**
 * One row of the "Send to" panel: a destination, its last delivery, its
 * switch, "Send test" and its edit button.
 */
import {
  deliveryLabel,
  destinationAddress,
  sameAddress,
} from "@core/alert-destinations";
import { commandErrorText } from "@core/command-error";
import { formatClock } from "@core/format";
import type { Destination, DestinationView } from "@core/generated/types";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useAlertDestinationCommands } from "../_hooks/use-alert-destinations";
import {
  type TestDelivery,
  useTestDelivery,
} from "../_hooks/use-test-delivery";

/** Props of `DestinationRow`. */
export interface DestinationRowProps {
  /** The destination and its last delivery, as the view holds them. */
  row: DestinationView;
  /** Opens the dialog on this destination ("Edit <name>"). */
  onEdit: () => void;
}

/** How each kind is named in a row's sub line. */
const KIND_NAMES = { ntfy: "ntfy", webhook: "Webhook" } as const;

/**
 * A `SettingsRow` labelled with the destination's name; its sub line is the
 * kind ("ntfy", "Webhook") and `destinationAddress`, then, in a live
 * status, the delivery state (`deliveryStatus`). Controls: "Send test to
 * <name>", disabled while its send is in flight and while the destination
 * is switched off; "Edit <name>"; and a switch named by the destination's
 * name that saves it with `enabled` flipped. The switch and both buttons
 * are disabled while that save is pending, so two quick clicks cannot undo
 * each other.
 */
export function DestinationRow({
  row,
  onEdit,
}: DestinationRowProps): ReactNode {
  const { destination } = row;
  const { saving, setEnabled } = useEnabledWrite(destination);
  // A new last delivery is newer than any test, so it replaces the test.
  const test = useTestDelivery(JSON.stringify(row.last));
  return (
    <SettingsRow
      label={destination.name}
      sub={<SubLine row={row} test={test} />}
    >
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Send test to ${destination.name}`}
          disabled={saving || test.sending || !destination.enabled}
          onClick={() => void test.send(destination)}
        >
          Send test
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${destination.name}`}
          disabled={saving}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Switch
          aria-label={destination.name}
          checked={destination.enabled}
          disabled={saving}
          onCheckedChange={setEnabled}
        />
      </div>
    </SettingsRow>
  );
}

/**
 * "ntfy · ntfy.sh/stat… · Delivered 14:02": the kind and the short address
 * (left out when empty), then the delivery state in a `status` region so a
 * screen reader hears "Sending…" and the outcome.
 */
function SubLine({ row, test }: { row: DestinationView; test: TestDelivery }) {
  const where = [
    KIND_NAMES[row.destination.kind.type],
    destinationAddress(row.destination),
  ]
    .filter(Boolean)
    .join(" · ");
  const status = deliveryStatus(row, test);
  return (
    <>
      {where}
      <span role="status">{status && ` · ${status}`}</span>
    </>
  );
}

/**
 * "Sending…" while a test to this address is out, then that test's outcome
 * or refusal; otherwise the last delivery. A test sent to an address the
 * destination no longer has says nothing about it, so it is not shown.
 */
function deliveryStatus(row: DestinationView, test: TestDelivery) {
  const tested =
    test.sent !== null && sameAddress(test.sent.kind, row.destination.kind);
  if (!tested) return deliveryLabel(row.last, formatClock);
  if (test.sending) return "Sending…";
  return test.failure ?? deliveryLabel(test.record ?? row.last, formatClock);
}

/**
 * Saves `destination` with `enabled` changed. `saving` is true until the
 * command answers; a refusal or a failed call says why in a toast, as the
 * Rules panel's switches do.
 */
function useEnabledWrite(destination: Destination) {
  const { save } = useAlertDestinationCommands();
  const [saving, setSaving] = useState(false);
  const fail = (error: unknown) => {
    console.error("[alerts] alert_destination_save failed", {
      id: destination.id,
      error,
    });
    toast.error(
      commandErrorText(error, "Couldn't save the destination. Nothing changed.")
    );
  };
  const setEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      const result = await save({ ...destination, enabled });
      if (result.status === "error") fail(result.error);
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  };
  return { saving, setEnabled: (on: boolean) => void setEnabled(on) };
}
