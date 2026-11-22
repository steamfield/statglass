/**
 * Dashboard-only host managing star prompt eligibility, calm-moment timing, and persistence.
 */
import type {
  StarPromptAction,
  StarPromptStatus,
} from "@core/generated/bindings";
import {
  GITHUB_REPO_URL,
  STAR_PROMPT_DELAY_MS,
  shouldShowStarPrompt,
} from "@core/star-prompt";
import type { Transport } from "@core/transport";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";
import { StarPromptCard } from "~/components/star-prompt-card";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useTransport } from "~/lib/transport-context";
import { useSettings } from "~/stores/settings-store";

const INELIGIBLE_STATUS: StarPromptStatus = {
  eligible: false,
  can_snooze: false,
};

/** Props for the dashboard GitHub star prompt host. */
export interface StarPromptHostProps {
  hasFocalNotice: boolean;
  delayMs?: number;
}

function useStarPromptStatus(transport: Transport) {
  const [status, setStatus] = useState<StarPromptStatus | null>(null);

  useEffect(() => {
    let active = true;
    transport.getStarPromptStatus().then(
      (fetchedStatus) => {
        if (active) {
          setStatus(fetchedStatus);
        }
      },
      (err: unknown) => {
        console.error("[star-prompt] getStarPromptStatus failed", err);
      }
    );
    return () => {
      active = false;
    };
  }, [transport]);

  return [status, setStatus] as const;
}

function useWindowVisibility(transport: Transport): boolean {
  const [windowVisible, setWindowVisible] = useState(false);

  useEffect(() => {
    let active = true;
    let eventSeen = false;
    const unsubscribe = transport.onWindowVisibility((visible) => {
      eventSeen = true;
      if (active) {
        setWindowVisible(visible);
      }
    });
    transport.windowVisible().then(
      (visible) => {
        if (active && !eventSeen) {
          setWindowVisible(visible);
        }
      },
      (err: unknown) => {
        console.error("[star-prompt] windowVisible failed", err);
      }
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [transport]);

  return windowVisible;
}

function useCalmDelay(
  eligible: boolean,
  windowVisible: boolean,
  delayMs: number
): boolean {
  const [delayElapsed, setDelayElapsed] = useState(false);

  useEffect(() => {
    if (!eligible || !windowVisible) {
      setDelayElapsed(false);
      return;
    }
    setDelayElapsed(false);
    const timerId = setTimeout(() => {
      setDelayElapsed(true);
    }, delayMs);
    return () => {
      clearTimeout(timerId);
    };
  }, [eligible, windowVisible, delayMs]);

  return delayElapsed;
}

function persistStarPromptAction(
  transport: Transport,
  action: StarPromptAction
): void {
  transport.actOnStarPrompt(action).then(
    (outcome) => {
      if (outcome.status === "error") {
        console.error("[star-prompt] actOnStarPrompt failed", {
          action,
          error: outcome.error,
        });
      }
    },
    (err: unknown) => {
      console.error("[star-prompt] actOnStarPrompt rejected", {
        action,
        err,
      });
    }
  );
}

function openGitHubRepo(transport: Transport): void {
  transport.openUrl(GITHUB_REPO_URL).catch((err: unknown) => {
    console.error("[star-prompt] openUrl failed", err);
    toast("Couldn't open link.");
  });
}

function recordPromptAction(
  transport: Transport,
  hidePrompt: () => void,
  action: StarPromptAction
): void {
  hidePrompt();
  if (action === "starred") {
    openGitHubRepo(transport);
  }
  persistStarPromptAction(transport, action);
}

/** Hosts the bottom-right GitHub star prompt in the dashboard window after a calm-moment delay. */
export const StarPromptHost = memo(function StarPromptHost({
  hasFocalNotice,
  delayMs = STAR_PROMPT_DELAY_MS,
}: StarPromptHostProps) {
  const transport = useTransport();
  const [status, setStatus] = useStarPromptStatus(transport);
  const onboardingCompleted = useSettings(
    (settings) => settings.onboarding.completed
  );
  const { health, error: historyError } = useHistoryHealth();
  const windowVisible = useWindowVisibility(transport);
  const delayElapsed = useCalmDelay(
    Boolean(status?.eligible),
    windowVisible,
    delayMs
  );

  const visible = shouldShowStarPrompt({
    status,
    onboardingCompleted: onboardingCompleted ?? false,
    hasFocalNotice,
    historyAvailable: health !== undefined && historyError === null,
    windowVisible,
    delayElapsed,
  });
  if (!visible || !status) {
    return null;
  }

  const hidePrompt = () => setStatus(INELIGIBLE_STATUS);

  return (
    <div className="fixed right-5 bottom-5 z-30 w-80 max-w-[calc(100vw-2rem)]">
      <StarPromptCard
        canSnooze={status.can_snooze}
        onStar={() => recordPromptAction(transport, hidePrompt, "starred")}
        onSnooze={() => recordPromptAction(transport, hidePrompt, "snoozed")}
        onDismiss={() => recordPromptAction(transport, hidePrompt, "dismissed")}
      />
    </div>
  );
});
