import { SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, type RefObject, useRef } from "react";
import { cn } from "~/lib/utils";
import styles from "./search-field.module.css";

/**
 * A filter field: the Processes header (name or PID), the Power page's
 * energy table (app, process or PID) and Settings search. Esc clears it, and
 * the clear button puts focus back in the field.
 */
export function SearchField({
  value,
  onChange,
  placeholder = "Name or PID",
  label = "Search processes by name or PID",
  type = "search",
  hint,
  inputRef,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The field's accessible name. */
  label?: string;
  /** `text` for a field that should not get the platform's search styling. */
  type?: "search" | "text";
  /** Shown at the right end while the field is empty (a shortcut hint). */
  hint?: ReactNode;
  /** The input element, for a caller that focuses it (a find shortcut). */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Classes for the wrapper; its default width is 224 px. */
  className?: string;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  return (
    <div className={cn("relative flex h-7 w-56 items-center", className)}>
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
      />
      <input
        ref={ref}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          styles.input,
          "h-full w-full rounded-control border border-border bg-btn pr-7 pl-7 text-foreground text-small outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
          hint !== undefined && "pr-9"
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute right-1.5 grid size-4 place-items-center rounded-chip text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      ) : (
        hint !== undefined && (
          <span aria-hidden className="pointer-events-none absolute right-1.5">
            {hint}
          </span>
        )
      )}
    </div>
  );
}
