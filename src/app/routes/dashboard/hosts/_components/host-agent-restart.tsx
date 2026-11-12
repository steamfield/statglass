import { commandErrorText } from "@core/command-error";
import type { CommandError } from "@core/generated/bindings";
import { useState } from "react";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useTransport } from "~/lib/transport-context";
import { RemoteSetupError } from "./remote-setup-error";

type State = "idle" | "restarting" | "restarted";

const SUB: Record<State, string> = {
  idle: "Restarts the statglass-agent service. History and identity stay; live values pause for a few seconds",
  restarting: "Restarting the agent…",
  restarted: "Restarted. Monitoring reconnects automatically",
};

/** Restarts a Linux host's agent service over SSH, for a daemon that is stuck. */
export function HostAgentRestart({
  hostId,
  disabled,
}: {
  hostId: string;
  disabled: boolean;
}) {
  const transport = useTransport();
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<CommandError | string | null>(null);
  const restart = async () => {
    setState("restarting");
    setError(null);
    try {
      const result = await transport.restartRemoteAgent(hostId);
      if (result.status === "error") {
        setError(result.error);
        setState("idle");
      } else setState("restarted");
    } catch (e) {
      console.error("[remote hosts] agent restart failed", {
        hostId,
        error: e,
      });
      setError(commandErrorText(e, "Please try again."));
      setState("idle");
    }
  };
  return (
    <SettingsPanel
      title="Agent on this host"
      after={error && <RemoteSetupError error={error} />}
    >
      <SettingsRow
        label="Restart agent"
        sub={<span role="status">{SUB[state]}</span>}
      >
        <Button
          variant="outline"
          disabled={disabled || state === "restarting"}
          onClick={() => void restart()}
        >
          {state === "restarting" ? "Restarting…" : "Restart"}
        </Button>
      </SettingsRow>
    </SettingsPanel>
  );
}
