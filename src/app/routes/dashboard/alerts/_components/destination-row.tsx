/**
 * One row of the "Send to" panel: a destination, its last delivery, its
 * switch, "Send test" and its edit button. Also home of `useTestDelivery`,
 * the test send the row and the destination dialog share.
 */
import { deliveryLabel, destinationAddress } from "@core/alert-destinations";
import { commandErrorText } from "@core/command-error";
import { formatClock } from "@core/format";
import type {
  DeliveryRecord,
  Destination,
  DestinationView,
} from "@core/generated/bindings";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useAlertDestinationCommands } from "../_hooks/use-alert-destinations";

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
 * kind ("ntfy", "Webhook") and `destinationAddress`, then `deliveryLabel`
 * of the newer of the last delivery and this row's last test ("Delivered
 * 14:02", "Failed 14:02 · HTTP 403"), or "Sending…" while a test is out.
 * Controls: "Send test to <name>", disabled while its send is in flight and
 * while the destination is switched off; "Edit <name>"; and a switch named
 * by the destination's name that saves it with `enabled` flipped. The
 * switch and both buttons are disabled while that save is pending, so two
 * quick clicks cannot undo each other.
 */
export function DestinationRow({
  row,
  onEdit,
}: DestinationRowProps): ReactNode {
  const { destination } = row;
  const { saving, setEnabled } = useEnabledWrite(destination);
  const test = useTestDelivery();
  return (
    <SettingsRow label={destination.name} sub={subLine(row, test)}>
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
 * "ntfy · ntfy.sh/stat… · Delivered 14:02": the kind, the short address
 * (left out when empty) and the delivery state, which is "Sending…" while a
 * test is out, the test's refusal, or the newer of the last delivery and
 * the last test.
 */
function subLine(row: DestinationView, test: TestDelivery): string {
  const status = test.sending
    ? "Sending…"
    : (test.failure ??
      deliveryLabel(newerRecord(row.last, test.record), formatClock));
  return [
    KIND_NAMES[row.destination.kind.type],
    destinationAddress(row.destination),
    status,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The later of two deliveries, either of which may be missing. */
function newerRecord(
  a: DeliveryRecord | null,
  b: DeliveryRecord | null
): DeliveryRecord | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.at_ms > a.at_ms ? b : a;
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

/** What `useTestDelivery` returns. */
export interface TestDelivery {
  /** True while a test send is out. */
  sending: boolean;
  /** The last test's outcome, timed when it answered; null before one. */
  record: DeliveryRecord | null;
  /** Why the last test could not be sent at all (a refusal); else null. */
  failure: string | null;
  /** Sends a test message to `destination`, saved or not. */
  send: (destination: Destination) => Promise<void>;
  /** Forgets the last test, for a form that has changed since. */
  clear: () => void;
}

type TestState = Pick<TestDelivery, "sending" | "record" | "failure">;

const IDLE: TestState = { sending: false, record: null, failure: null };

/**
 * One test send at a time: `test` through the command, its outcome kept as
 * a delivery record at the moment it answered, or the command's message
 * when it refused (an invalid form) or the call failed.
 */
export function useTestDelivery(): TestDelivery {
  const { test } = useAlertDestinationCommands();
  const [state, setState] = useState<TestState>(IDLE);
  const fail = (error: unknown) => {
    console.error("[alerts] alert_destination_test failed", error);
    setState({
      sending: false,
      record: null,
      failure: commandErrorText(error, "Couldn't send the test."),
    });
  };
  const send = async (destination: Destination) => {
    setState({ ...IDLE, sending: true });
    try {
      const result = await test(destination);
      if (result.status === "error") {
        fail(result.error);
        return;
      }
      const record = { at_ms: Date.now(), outcome: result.data };
      setState({ sending: false, record, failure: null });
    } catch (error) {
      fail(error);
    }
  };
  return { ...state, send, clear: () => setState(IDLE) };
}
