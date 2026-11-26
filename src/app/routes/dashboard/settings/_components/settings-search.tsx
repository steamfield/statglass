/**
 * The Settings search field in the page header, with a ⌘F hint while empty.
 * ⌘F or Ctrl+F on the page focuses and selects it; Escape in it clears the
 * query (`SearchField`).
 */
import { type RefObject, useEffect } from "react";
import { SearchField } from "~/components/search-field";

/** Where an open dialog keeps keyboard shortcuts to itself. */
const DIALOG = "[role=dialog],[role=alertdialog]";

/** True when the event's target takes typed text. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/**
 * True for ⌘F, or Ctrl+F outside a text field, with no other modifier.
 * In a macOS text field Ctrl+F moves the cursor forward, so it stays there.
 */
function isFindShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "f" || event.shiftKey || event.altKey) {
    return false;
  }
  if (event.metaKey) return !event.ctrlKey;
  return event.ctrlKey && !isEditable(event.target);
}

/** True when the event comes from inside an open dialog. */
function isInDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(DIALOG) !== null;
}

/** Focuses and selects the field on the find shortcut while it is mounted. */
function useFindShortcut(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const input = inputRef.current;
      if (!input || isInDialog(event.target) || !isFindShortcut(event)) return;
      // The webview's own find bar would search the page text, not settings.
      event.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [inputRef]);
}

/** The search field for every Settings tab, controlled by `value`. */
export function SettingsSearch({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The input, owned by the route so results can hand focus back to it. */
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  useFindShortcut(inputRef);
  return (
    <SearchField
      type="text"
      value={value}
      onChange={onChange}
      placeholder="Search settings"
      label="Search settings"
      inputRef={inputRef}
      className="w-full sm:w-55"
      hint={
        <kbd className="rounded-chip border border-border px-1 font-sans text-caption text-muted-foreground leading-4">
          ⌘F
        </kbd>
      }
    />
  );
}
