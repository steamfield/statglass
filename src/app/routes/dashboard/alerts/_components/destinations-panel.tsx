/**
 * The Alerts page's "Send to" panel: where a fired alert goes besides the
 * Timeline (plan/rfc-alerts.md section 5).
 */
import { newDestination } from "@core/alert-destinations";
import { commandErrorText } from "@core/command-error";
import type { AlertDestinationsView } from "@core/generated/bindings";
import { appKeys } from "@core/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type Ref, useRef, useState } from "react";
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
 * error, never an empty list. When the dialog closes on a destination that
 * is gone (deleted), focus moves to "Add destination", since the row whose
 * Edit button opened it no longer exists.
 */
export function DestinationsPanel({
  remote = false,
}: {
  remote?: boolean;
} = {}): ReactNode {
  const { view, error } = useAlertDestinations();
  const [draft, setDraft] = useState<DestinationDraft | null>(null);
  const { addButton, onCloseAutoFocus } = useFocusAfterClose(draft);
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
        after={
          <>
            {remote && (
              <p className="m-0 text-label text-muted-foreground">
                Alerts from this host are sent from this Mac.
              </p>
            )}
            <PanelFooter problem={problem} addButton={addButton} onAdd={add} />
          </>
        }
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
      <DestinationDialog
        draft={draft}
        onClose={() => setDraft(null)}
        onCloseAutoFocus={onCloseAutoFocus}
      />
    </>
  );
}

/**
 * The ref for "Add destination", and the dialog's close-focus handler that
 * moves focus there when the edited destination is no longer in the list.
 * The list is read from the query cache when the dialog closes, after the
 * delete has written it.
 */
function useFocusAfterClose(draft: DestinationDraft | null) {
  const client = useQueryClient();
  const addButton = useRef<HTMLButtonElement>(null);
  const onCloseAutoFocus = (event: Event) => {
    if (draft === null || draft.isNew) return;
    const view = client.getQueryData<AlertDestinationsView>(
      appKeys.alertDestinations
    );
    const id = draft.destination.id;
    if (view?.destinations.some((r) => r.destination.id === id)) return;
    event.preventDefault();
    addButton.current?.focus();
  };
  return { addButton, onCloseAutoFocus };
}

/** Why the list is incomplete, if it is, then "Add destination". */
function PanelFooter({
  problem,
  addButton,
  onAdd,
}: {
  problem: string | null;
  addButton: Ref<HTMLButtonElement>;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2.5">
      {problem !== null && (
        <InlineMessage tone="error">{problem}</InlineMessage>
      )}
      <Button ref={addButton} variant="outline" size="sm" onClick={onAdd}>
        Add destination
      </Button>
    </div>
  );
}
