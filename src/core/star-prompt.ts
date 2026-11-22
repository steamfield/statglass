/**
 * Pure star-prompt constants, calm-moment display guard, and non-PII system diagnostics formatter.
 */
import type { StarPromptStatus } from "@core/generated/bindings";

/** Repository URL opened when the user chooses to star StatGlass on GitHub. */
export const GITHUB_REPO_URL = "https://github.com/steamfield/statglass";

/** Issues URL opened from Feedback entry points. */
export const GITHUB_ISSUES_URL =
  "https://github.com/steamfield/statglass/issues";

/** Delay after dashboard mount before showing the star prompt (8 seconds). */
export const STAR_PROMPT_DELAY_MS = 8_000;

/** Inputs used to decide whether the dashboard should render the star prompt right now. */
export interface StarPromptGuardInput {
  status: StarPromptStatus | null | undefined;
  onboardingCompleted: boolean;
  hasFocalNotice: boolean;
  historyAvailable: boolean;
  windowVisible: boolean;
  delayElapsed: boolean;
}

/**
 * Returns whether the dashboard should display the GitHub star hover-card right now.
 *
 * @throws {Error} Stub throws until implemented.
 */
export function shouldShowStarPrompt(_input: StarPromptGuardInput): boolean {
  throw new Error("not implemented");
}

/** Non-PII environment metadata formatted for bug reports and feature requests. */
export interface SystemDiagnosticsInput {
  appVersion: string;
  osVersion: string | null | undefined;
  chip: string | null | undefined;
  model: string | null | undefined;
}

/**
 * Formats non-PII system metadata (`StatGlass v<ver> · macOS <os> · <chip>`) for clipboard copy.
 *
 * @throws {Error} Stub throws until implemented.
 */
export function formatSystemDiagnostics(
  _input: SystemDiagnosticsInput
): string {
  throw new Error("not implemented");
}
