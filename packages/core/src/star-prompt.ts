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

const DIAGNOSTIC_SEPARATOR = " · ";
const DEFAULT_OS_PREFIX = "macOS ";
const LEADING_VERSION_PREFIX = /^[vV]+/;
const KNOWN_OS_PREFIX = /^(?:macos|linux)/i;

/** Inputs used to decide whether the dashboard should render the star prompt right now. */
export interface StarPromptGuardInput {
  status: StarPromptStatus | null | undefined;
  onboardingCompleted: boolean;
  hasFocalNotice: boolean;
  historyAvailable: boolean;
  windowVisible: boolean;
  delayElapsed: boolean;
}

/** Returns whether the dashboard should display the GitHub star hover-card right now. */
export function shouldShowStarPrompt(input: StarPromptGuardInput): boolean {
  return (
    Boolean(input.status?.eligible) &&
    input.onboardingCompleted &&
    !input.hasFocalNotice &&
    input.historyAvailable &&
    input.windowVisible &&
    input.delayElapsed
  );
}

/** Non-PII environment metadata formatted for bug reports and feature requests. */
export interface SystemDiagnosticsInput {
  appVersion: string;
  osVersion: string | null | undefined;
  chip: string | null | undefined;
  model: string | null | undefined;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatOsSegment(osVersion: string | null | undefined): string | null {
  const trimmedOs = trimNonEmpty(osVersion);
  if (trimmedOs === null) {
    return null;
  }
  return KNOWN_OS_PREFIX.test(trimmedOs)
    ? trimmedOs
    : `${DEFAULT_OS_PREFIX}${trimmedOs}`;
}

/** Formats non-PII system metadata for clipboard copy in bug reports and feature requests. */
export function formatSystemDiagnostics({
  appVersion,
  osVersion,
  chip,
  model,
}: SystemDiagnosticsInput): string {
  const cleanedVersion = appVersion.trim().replace(LEADING_VERSION_PREFIX, "");
  const segments: string[] = [`StatGlass v${cleanedVersion}`];

  const osSegment = formatOsSegment(osVersion);
  if (osSegment !== null) {
    segments.push(osSegment);
  }

  const hardwareSegment = trimNonEmpty(chip) ?? trimNonEmpty(model);
  if (hardwareSegment !== null) {
    segments.push(hardwareSegment);
  }

  return segments.join(DIAGNOSTIC_SEPARATOR);
}
