/**
 * The destination editor: a dialog over one ntfy topic or webhook, saved
 * through `saveAlertDestination`.
 */
import { deliveryLabel } from "@core/alert-destinations";
import { commandErrorText } from "@core/command-error";
import { formatClock } from "@core/format";
import type { AlertDestinationsView, Destination } from "@core/generated/types";
import type { CommandResult } from "@core/transport";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import {
  useAlertDestinationCommands,
  useAlertDestinations,
} from "../_hooks/use-alert-destinations";
import {
  type TestDelivery,
  useTestDelivery,
} from "../_hooks/use-test-delivery";
import {
  DestinationFields,
  type DestinationForm,
  destinationFromForm,
  formFromDestination,
} from "./destination-fields";

/** The destination the dialog edits, and whether it is new. */
export interface DestinationDraft {
  destination: Destination;
  /** True for "Add destination": no Delete, and Save appends. */
  isNew: boolean;
}

/** Props of `DestinationDialog`. */
export interface DestinationDialogProps {
  /** The destination to edit; null keeps the dialog closed. */
  draft: DestinationDraft | null;
  /** Close without anything further: after Save, Delete, Cancel or Escape. */
  onClose: () => void;
  /**
   * Where focus goes once the dialog has closed, as Radix's
   * `onCloseAutoFocus`: prevent the default to move it elsewhere.
   */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/**
 * The "Add destination" / "Edit destination" dialog, following the rule
 * dialog's patterns. A kind control ("ntfy", "Webhook") switches the fields
 * and keeps the name. ntfy: "Name", "Server" (default https://ntfy.sh),
 * "Topic" with "Generate" (`generateTopic`), "Access token" (a password
 * input, optional) and three plain lines on subscribing from the phone,
 * with a note when an existing destination's topic has changed.
 * Webhook: "Name" and "URL". "Send test" sends the unsaved form and shows
 * "Sending…", then the outcome's `deliveryLabel`; any edit clears that
 * line and drops the answer of a test still out. "Save" validates through
 * the command, closes on success and shows a rejection's message inline,
 * keeping the form; a pending save disables Save only. "Delete" (existing
 * destinations only) removes it and closes. "Cancel" and Escape always
 * close and write nothing.
 */
export function DestinationDialog({
  draft,
  onClose,
  onCloseAutoFocus,
}: DestinationDialogProps): ReactNode {
  if (draft === null) return null;
  return (
    <DestinationEditor
      key={draft.destination.id}
      draft={draft}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}

/**
 * Runs one save or delete. Closes on success and keeps the command's
 * message on failure; once the dialog has closed, a late answer changes
 * nothing here.
 */
function useDestinationWrite(onClose: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const write = async (
    command: string,
    run: () => Promise<CommandResult<AlertDestinationsView>>
  ) => {
    setSaving(true);
    setError(null);
    const failure = await writeFailure(command, run);
    if (!open.current) return;
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };
  return { saving, error, write, clearError: () => setError(null) };
}

/** Runs one destination write; the failure as inline text, or null when done. */
async function writeFailure(
  command: string,
  run: () => Promise<CommandResult<AlertDestinationsView>>
): Promise<string | null> {
  const fallback = "Couldn't change the destination. Nothing changed.";
  try {
    const result = await run();
    if (result.status === "ok") return null;
    console.error(`[alerts] ${command} rejected`, result.error);
    return commandErrorText(result.error, fallback);
  } catch (err) {
    console.error(`[alerts] ${command} failed`, err);
    return commandErrorText(err, fallback);
  }
}

/**
 * The destination to save: the form, switched on or off as the destination
 * is now. Another window may have flipped its switch since the dialog
 * opened, and the dialog does not show that switch, so it keeps the
 * current state rather than the one it opened with.
 */
function toSave(
  form: DestinationForm,
  view: AlertDestinationsView | undefined
): Destination {
  const now = view?.destinations.find((r) => r.destination.id === form.id);
  const enabled = now?.destination.enabled ?? form.enabled;
  return destinationFromForm({ ...form, enabled });
}

/** The topic an existing ntfy destination is saved with; null otherwise. */
function savedTopic(draft: DestinationDraft): string | null {
  const { kind } = draft.destination;
  return draft.isNew || kind.type !== "ntfy" ? null : kind.topic;
}

/** The open dialog for one draft, holding its form until it closes. */
function DestinationEditor({
  draft,
  onClose,
  onCloseAutoFocus,
}: Required<DestinationDialogProps> & { draft: DestinationDraft }) {
  const { view } = useAlertDestinations();
  const { save, remove } = useAlertDestinationCommands();
  const [form, setForm] = useState(() =>
    formFromDestination(draft.destination)
  );
  const { saving, error, write, clearError } = useDestinationWrite(onClose);
  const test = useTestDelivery();
  const edit = (next: DestinationForm) => {
    setForm(next);
    clearError();
    test.clear();
  };
  const onSave = () =>
    void write("alert_destination_save", () => save(toSave(form, view)));
  const onDelete = () =>
    void write("alert_destination_delete", () => remove(form.id));
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      >
        <header className="border-border-subtle border-b px-5 py-4 pr-12">
          <DialogTitle>
            {draft.isNew ? "Add destination" : "Edit destination"}
          </DialogTitle>
        </header>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
          <fieldset disabled={saving} className="flex min-w-0 flex-col gap-5">
            <DestinationFields
              form={form}
              savedTopic={savedTopic(draft)}
              onChange={edit}
            />
          </fieldset>
          <TestLine test={test} />
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
        </div>
        <EditorFooter
          isNew={draft.isNew}
          saving={saving}
          sending={test.sending}
          onDelete={onDelete}
          onTest={() => void test.send(destinationFromForm(form))}
          onCancel={onClose}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete (existing destinations only) and Send test, then Cancel and Save.
 * A pending save locks Delete and Save; Cancel always works.
 */
function EditorFooter(props: {
  isNew: boolean;
  saving: boolean;
  sending: boolean;
  onDelete: () => void;
  onTest: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { isNew, saving, sending } = props;
  return (
    <footer className="flex shrink-0 gap-2 border-border-subtle border-t px-5 py-3">
      {!isNew && (
        <Button variant="outline" disabled={saving} onClick={props.onDelete}>
          Delete
        </Button>
      )}
      <Button variant="outline" disabled={sending} onClick={props.onTest}>
        Send test
      </Button>
      <span className="flex-1" />
      <Button variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
      <Button disabled={saving} onClick={props.onSave}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </footer>
  );
}

/** "Sending…", then the test's outcome or why it could not be sent. */
function TestLine({ test }: { test: TestDelivery }) {
  if (test.sending)
    return <InlineMessage tone="status">Sending…</InlineMessage>;
  if (test.failure !== null) {
    return <InlineMessage tone="error">{test.failure}</InlineMessage>;
  }
  const label = deliveryLabel(test.record, formatClock);
  if (label === null) return null;
  const failed = test.record?.outcome.kind === "failed";
  return (
    <InlineMessage tone={failed ? "error" : "status"}>{label}</InlineMessage>
  );
}
