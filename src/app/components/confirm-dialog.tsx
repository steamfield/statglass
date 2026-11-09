import { AlertDialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  DialogFooter,
  DialogHeader,
  dialogContentClass,
  dialogDescriptionClass,
  dialogOverlayClass,
  dialogTitleClass,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/** One row of a review list: what the action touches, and its state. */
export interface ReviewItem {
  key: string;
  label: ReactNode;
  /** A second muted line under the label. */
  note?: ReactNode;
  /** Right-aligned state: an exclusion, a result. */
  status?: ReactNode;
  tone?: "muted" | "error";
}

/** The bounded, scrolling list of what a confirmation acts on. */
export function ReviewList({
  items,
  label,
}: {
  items: readonly ReviewItem[];
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className="m-0 max-h-60 min-w-0 list-none divide-y divide-border-subtle overflow-y-auto border-border-subtle border-y p-0 text-small"
    >
      {items.map((item) => (
        <li key={item.key} className="flex justify-between gap-3 py-2">
          <span className="min-w-0 break-words">
            {item.label}
            {item.note && (
              <span className="block text-muted-foreground">{item.note}</span>
            )}
          </span>
          {item.status && (
            <span
              className={cn(
                "shrink-0",
                item.tone === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {item.status}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant?: ComponentProps<typeof Button>["variant"];
  /**
   * Runs the action. The dialog stays open until the caller closes it, so
   * an async action can keep it up (with `busy`) until it is done.
   */
  onConfirm: () => void;
  /** Disables the confirm button while the action runs. */
  busy?: boolean;
  /**
   * Keeps the dialog open while busy: Cancel and Escape do nothing (a signal
   * already sent cannot be taken back).
   */
  lockWhileBusy?: boolean;
  /** "Cancel" by default; `null` leaves only the confirm button (a done state). */
  cancelLabel?: ReactNode;
  /** What the action touches, listed under the description. */
  items?: readonly ReviewItem[];
  /** The review list's accessible name. */
  itemsLabel?: string;
  /** Width override for the content ("sm:max-w-sm"). */
  className?: string;
  children?: ReactNode;
  confirmDisabled?: boolean;
}

/**
 * A yes/no confirmation before an action: an `alertdialog`, so a click
 * outside does not dismiss it and Cancel takes the initial focus. Escape
 * and Cancel close it unless it is locked while busy. Dialog look
 * (ui/dialog.tsx) with no close button.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant = "default",
  onConfirm,
  busy = false,
  lockWhileBusy = false,
  cancelLabel = "Cancel",
  items,
  itemsLabel = "Items to review",
  className,
  children,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const locked = lockWhileBusy && busy;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClass} />
        <AlertDialog.Content className={cn(dialogContentClass, className)}>
          <DialogHeader>
            <AlertDialog.Title className={dialogTitleClass}>
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClass}>
              {description}
            </AlertDialog.Description>
          </DialogHeader>
          {items && <ReviewList items={items} label={itemsLabel} />}
          {children}
          <DialogFooter>
            {cancelLabel !== null && (
              <AlertDialog.Cancel asChild>
                <Button variant="outline" disabled={locked}>
                  {cancelLabel}
                </Button>
              </AlertDialog.Cancel>
            )}
            <Button
              variant={confirmVariant}
              disabled={busy || confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
