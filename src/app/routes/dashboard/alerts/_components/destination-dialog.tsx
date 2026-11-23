/**
 * The destination editor: a dialog over one ntfy topic or webhook, saved
 * through `saveAlertDestination`.
 */
import type { Destination } from "@core/generated/bindings";
import type { ReactNode } from "react";

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
}

/**
 * The "Add destination" / "Edit destination" dialog, following the rule
 * dialog's patterns. A kind control ("ntfy", "Webhook") switches the fields
 * and keeps the name. ntfy: "Name", "Server" (default https://ntfy.sh),
 * "Topic" with "Generate" (`generateTopic`), "Access token" (a password
 * input, optional) and three plain lines on subscribing from the phone.
 * Webhook: "Name" and "URL". "Send test" sends the unsaved form and shows
 * "Sending…", then the outcome's `deliveryLabel`. "Save" validates through
 * the command, closes on success and shows a rejection's message inline,
 * keeping the form; a pending save disables Save only. "Delete" (existing
 * destinations only) removes it and closes. "Cancel" and Escape always
 * close and write nothing.
 *
 * Scaffold placeholder: lane a builds it.
 */
export function DestinationDialog({
  draft,
  onClose,
}: DestinationDialogProps): ReactNode {
  void draft;
  void onClose;
  return null;
}
