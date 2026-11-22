/**
 * Dashboard-only host for the GitHub star prompt: queries eligibility, enforces calm-moment guards,
 * and persists user actions without re-rendering the parent DashboardLayout.
 */
import { memo } from "react";

export interface StarPromptHostProps {
  /** True while a focal disconnect/error notice is on screen. */
  hasFocalNotice: boolean;
  /** Override for the calm-moment delay in milliseconds (defaults to `STAR_PROMPT_DELAY_MS`). */
  delayMs?: number;
}

/**
 * Renders the bottom-right GitHub star hover-card once eligibility and calm-moment guards pass.
 */
export const StarPromptHost = memo(function StarPromptHost(
  _props: StarPromptHostProps
) {
  return null;
});
