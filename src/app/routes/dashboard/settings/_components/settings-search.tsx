/**
 * The Settings search field in the page header: a magnifier, the query, a
 * ⌘F hint while empty and a clear button while not. ⌘F or Ctrl+F anywhere
 * on the page focuses it; Escape in it clears the query.
 */
import { SearchIcon, XIcon } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";

/** True for ⌘F or Ctrl+F, the shortcut that jumps to the field. */
function isFindShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
}

/** Focuses and selects the field on ⌘F or Ctrl+F while it is mounted. */
function useFindShortcut(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const input = inputRef.current;
      if (!input || !isFindShortcut(event)) return;
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
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useFindShortcut(inputRef);

  return (
    <div className="relative flex h-7 w-full items-center sm:w-55">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !value) return;
          event.preventDefault();
          onChange("");
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        autoComplete="off"
        className="h-full w-full rounded-control border border-border bg-btn pr-9 pl-7 text-foreground text-small outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute right-1.5 grid size-4 place-items-center rounded-chip text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      ) : (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-1.5 rounded-chip border border-border px-1 font-sans text-caption text-muted-foreground leading-4"
        >
          ⌘F
        </kbd>
      )}
    </div>
  );
}
