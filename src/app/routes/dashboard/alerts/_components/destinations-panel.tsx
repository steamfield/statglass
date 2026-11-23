/**
 * The Alerts page's "Send to" panel: where a fired alert goes besides the
 * Timeline (plan/rfc-alerts.md section 5).
 */
import { newDestination } from "@core/alert-destinations";
import { commandErrorText } from "@core/command-error";
import { type ReactNode, useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useAlertDestinations } from "../_hooks/use-alert-destinations";
import { DestinationDialog, type DestinationDraft } from "./destination-dialog";
import { DestinationRow } from "./destination-row";

/**
 * A `SettingsPanel` titled "Send to". A fixed first row, "Notifications on
 * this Mac", then one `DestinationRow` per destination from
 * `useAlertDestinations`, then an "Add destination" button that opens
 * `DestinationDialog` on `newDestination("ntfy", <new id>)`. A row's
 * "Edit <name>" opens the dialog on that destination. The panel owns the
 * dialog's draft, so the page only places the panel. A `load_error` shows
 * as one inline message and the panel still works; a failed read shows its
 * error, never an empty list.
 */
export function DestinationsPanel(): ReactNode {
  const { view, error } = useAlertDestinations();
  const [draft, setDraft] = useState<DestinationDraft | null>(null);
  const add = () =>
    setDraft({
      destination: newDestination("ntfy", crypto.randomUUID()),
      isNew: true,
    });
  const problem =
    error === null
      ? (view?.load_error ?? null)
      : commandErrorText(error, "Couldn't read the destinations.");
  return (
    <>
      <SettingsPanel
        title="Send to"
        after={<PanelFooter problem={problem} onAdd={add} />}
      >
        <SettingsRow label="Notifications on this Mac" sub="Always on" />
        {view?.destinations.map((row) => (
          <DestinationRow
            key={row.destination.id}
            row={row}
            onEdit={() =>
              setDraft({ destination: row.destination, isNew: false })
            }
          />
        ))}
      </SettingsPanel>
      <DestinationDialog draft={draft} onClose={() => setDraft(null)} />
    </>
  );
}

/** Why the list is incomplete, if it is, then "Add destination". */
function PanelFooter({
  problem,
  onAdd,
}: {
  problem: string | null;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2.5">
      {problem !== null && (
        <InlineMessage tone="error">{problem}</InlineMessage>
      )}
      <Button variant="outline" size="sm" onClick={onAdd}>
        Add destination
      </Button>
    </div>
  );
}
