/**
 * Presentational bottom-right hover-card toast inviting engaged users to star StatGlass on GitHub.
 */

export interface StarPromptCardProps {
  /** Whether a single 7-day "Not now" snooze is still available. */
  canSnooze: boolean;
  /** Called when the user clicks the primary "Star on GitHub" CTA. */
  onStar: () => void;
  /** Called when the user clicks "Not now" to snooze for 7 days. */
  onSnooze: () => void;
  /** Called when the user permanently dismisses via the close button, "Don't ask again", or Escape. */
  onDismiss: () => void;
  className?: string;
}

/**
 * Non-modal floating card asking engaged users to star StatGlass on GitHub.
 *
 * @throws {Error} Stub throws until implemented.
 */
export function StarPromptCard(_props: StarPromptCardProps): never {
  throw new Error("not implemented");
}
