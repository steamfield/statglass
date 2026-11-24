import type { StarPromptAction } from "@core/generated/types";
import type { Transport } from "@core/transport";
import { toast } from "sonner";

/**
 * Opens `url` in the default browser. A failure is logged with `context` and
 * shown as a quiet toast; it never throws.
 */
export function openExternalUrl(
  transport: Transport,
  url: string,
  context: string
): void {
  transport.openUrl(url).catch((err: unknown) => {
    console.error(`[${context}] openUrl failed`, err);
    toast("Couldn't open link.");
  });
}

/**
 * Saves a star-prompt choice. Rust announces the new status to every window,
 * so the caller only logs a failure; it never throws.
 */
export function recordStarPromptAction(
  transport: Transport,
  action: StarPromptAction,
  context: string
): void {
  transport.actOnStarPrompt(action).then(
    (outcome) => {
      if (outcome.status === "error") {
        console.error(`[${context}] actOnStarPrompt failed`, {
          action,
          error: outcome.error,
        });
      }
    },
    (err: unknown) => {
      console.error(`[${context}] actOnStarPrompt rejected`, { action, err });
    }
  );
}
