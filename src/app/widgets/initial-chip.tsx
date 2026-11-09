export interface InitialChipProps {
  /** One character, usually the process name's first letter. */
  text: string;
}

/** 16 px initial for a process. */
export function InitialChip({ text }: InitialChipProps) {
  return (
    <span
      aria-hidden
      className="figures inline-flex size-4 shrink-0 items-center justify-center rounded-chip bg-raised text-fg-subtle text-micro"
    >
      {text.slice(0, 1)}
    </span>
  );
}
