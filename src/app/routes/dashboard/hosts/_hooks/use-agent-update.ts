import { commandErrorText } from "@core/command-error";
import { hostKeys } from "@core/query-keys";
import { remoteErrorText } from "@core/remote-errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTransport } from "~/lib/transport-context";

const AGENT_UPDATE = ["agent-update"] as const;

/**
 * One mutation per request under the shared agent-update key. Rust status
 * drives progress in cards and Update all. Resolves to an error message,
 * or null once the host accepted the request.
 */
export function useAgentUpdate() {
  const transport = useTransport();
  const cache = useQueryClient();
  return useMutation({
    mutationKey: AGENT_UPDATE,
    mutationFn: async (id: string): Promise<string | null> => {
      try {
        const result = await transport.updateRemoteAgent(id);
        return result.status === "error" ? remoteErrorText(result.error) : null;
      } catch (e) {
        console.error("[remote hosts] agent update failed", {
          hostId: id,
          error: e,
        });
        return commandErrorText(e, "Please try again.");
      } finally {
        await cache.invalidateQueries({ queryKey: hostKeys.remote() });
        await cache.invalidateQueries({ queryKey: hostKeys.updates(id) });
      }
    },
  });
}
