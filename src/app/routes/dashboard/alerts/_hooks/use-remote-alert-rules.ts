import { commandError } from "@core/command-error";
import type { AlertRule, RemoteHostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import {
  type RulesWriteAction,
  remoteRulesWriteErrorText,
  rulesConnectionLost,
  rulesDisconnectedText,
} from "@core/remote-alert-rules";
import { unwrap } from "@core/transport";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTransport } from "~/lib/transport-context";

const CANNOT_KEEP =
  "Editing is unavailable because a rule made by a newer version can’t be kept.";

export type RulesWriteResult =
  | { saved: true }
  | { saved: false; error: string | null };

export interface ReloadRulesAction {
  run: () => void;
  pending: boolean;
}

export function useRemoteAlertRules({ config, status }: RemoteHostRecord) {
  const transport = useTransport();
  const client = useQueryClient();
  const key = hostKeys.alertRules(config.id);
  const connected = status.state === "connected";
  const query = useQuery({
    queryKey: key,
    queryFn: () => unwrap(transport.remoteAlertRules(config.id)),
    enabled: connected,
    staleTime: 0,
    gcTime: Infinity,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const { agent_version: version } = status;
  const previousVersion = useRef(version);
  useEffect(() => {
    if (connected && previousVersion.current !== version) {
      void client.invalidateQueries(
        { queryKey: hostKeys.alertRules(config.id) },
        { cancelRefetch: false }
      );
    }
    previousVersion.current = version;
  }, [client, config.id, connected, version]);
  const saving = useIsMutating({ mutationKey: key }) > 0;
  const save = useMutation({
    mutationKey: key,
    mutationFn: (input: {
      revision: number;
      rules: AlertRule[];
      keep: string[];
      readCount: number;
    }) =>
      unwrap(
        transport.setRemoteAlertRules(
          config.id,
          input.revision,
          input.rules,
          input.keep
        )
      ),
    onSuccess: async (answer) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, answer);
    },
    onError: async (error) => {
      if (commandError(error)?.kind === "remote_rules_changed") {
        await client.invalidateQueries({ queryKey: key });
      }
    },
  });
  const readCount = client.getQueryState(key)?.dataUpdateCount ?? 0;
  // A timed-out write may have been applied. Keep the last answer read-only
  // until a new read succeeds, even if the host still reports connected.
  const writeDisconnected =
    rulesConnectionLost(save.error) && save.variables?.readCount === readCount;
  const disconnected =
    !connected || rulesConnectionLost(query.error) || writeDisconnected;
  const staleReadFailed =
    query.isError && commandError(save.error)?.kind === "remote_rules_changed";
  const readFailure = staleReadFailed
    ? "Couldn't load the latest rules."
    : null;
  const reason = disconnected
    ? rulesDisconnectedText(config.name)
    : query.data?.newer.some(({ id }) => id === null)
      ? CANNOT_KEEP
      : readFailure;
  const disabled =
    reason !== null ||
    !query.data ||
    query.isError ||
    query.isFetching ||
    saving;

  const write = async (
    rules: AlertRule[],
    action: RulesWriteAction
  ): Promise<RulesWriteResult> => {
    if (disabled || !query.data || client.isMutating({ mutationKey: key })) {
      return {
        saved: false,
        error: reason ? null : "Wait for the rules to finish loading.",
      };
    }
    const { revision, newer } = query.data;
    const keep = newer.flatMap(({ id }) => (id === null ? [] : [id]));
    try {
      await save.mutateAsync({ revision, rules, keep, readCount });
      return { saved: true };
    } catch (error) {
      if (!commandError(error)) {
        console.error("[alerts] writing remote rules failed", {
          hostId: config.id,
          error,
        });
      }
      // Availability handles failed reads and connection errors until a fresh read succeeds.
      const current = client.getQueryState(key);
      const refreshed =
        current?.status === "success" && current.dataUpdateCount > readCount;
      return {
        saved: false,
        error: remoteRulesWriteErrorText(error, config.name, action, refreshed),
      };
    }
  };

  const reload: ReloadRulesAction | null =
    connected && (disconnected || staleReadFailed)
      ? {
          run: () => void query.refetch({ cancelRefetch: false }),
          pending: query.isFetching,
        }
      : null;
  return { query, disabled, reason, write, reload };
}
