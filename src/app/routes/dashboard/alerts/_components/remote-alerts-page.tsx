import { availableMetrics, newRule } from "@core/alerts";
import type { AlertRule, RemoteHostRecord } from "@core/generated/bindings";
import { historyUnavailable } from "@core/history-state";
import {
  remoteRulesErrorText,
  rulesAgentUnsupported,
  rulesChangedText,
} from "@core/remote-alert-rules";
import { hostsNeedingUpdate } from "@core/remote-hosts";
import { replaceEqualDeep } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { HistoryUnavailableBanner } from "~/components/history-unavailable-banner";
import { InlineMessage } from "~/components/inline-message";
import { PageHeader } from "~/components/page-header";
import { QueryNotice } from "~/components/query-notice";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useSettings } from "~/stores/settings-store";
import { HostCardActions } from "../../hosts/_components/host-card-actions";
import { remoteHostCardModel } from "../../hosts/_lib/host-card-model";
import { useRemoteAlertRules } from "../_hooks/use-remote-alert-rules";
import { useSeriesKeys } from "../_hooks/use-series-keys";
import { DestinationsPanel } from "./destinations-panel";
import { RecentAlerts } from "./recent-alerts";
import { ReloadRulesButton, RuleDialog, type RuleDraft } from "./rule-dialog";
import {
  CustomRuleRow,
  useLastAlerts,
  useMeasuredMetrics,
} from "./rules-panel";

const NO_RULES: AlertRule[] = [];

export function RemoteAlertsPending({
  name,
  failed,
}: {
  name: string;
  failed: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Alerts on ${name}`}
        actions={<Button disabled>New rule</Button>}
      />
      <div className="max-w-2xl">
        <SettingsPanel title="Rules">
          <InlineMessage
            tone={failed ? "error" : "status"}
            className="px-4 py-3.5"
          >
            {failed ? "Couldn't load the host status." : "Loading rules…"}
          </InlineMessage>
        </SettingsPanel>
      </div>
    </div>
  );
}

function changedDraft(rules: AlertRule[], draft: RuleDraft | null) {
  if (!draft || draft.isNew) return false;
  const latest = rules.find(({ id }) => id === draft.rule.id);
  return replaceEqualDeep(draft.rule, latest) !== draft.rule;
}

export function RemoteAlertsPage({ remote }: { remote: RemoteHostRecord }) {
  const { name } = remote.config;
  const state = useRemoteAlertRules(remote);
  const seriesKeys = useSeriesKeys();
  const firstMetric = useMemo(
    () => availableMetrics(seriesKeys)[0],
    [seriesKeys]
  );
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const rules = state.query.data?.rules ?? NO_RULES;
  const conflict = changedDraft(rules, editing);
  const draftReason = conflict
    ? `${rulesChangedText(name)} Close this draft to see the latest rules.`
    : null;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Alerts on ${name}`}
        actions={
          <Button
            disabled={state.disabled || firstMetric === undefined}
            onClick={() => {
              if (firstMetric === undefined) return;
              setEditing({
                rule: newRule(firstMetric, crypto.randomUUID()),
                isNew: true,
              });
            }}
          >
            New rule
          </Button>
        }
      />
      <div className="flex max-w-2xl flex-col gap-5">
        <RemoteRulesPanel
          remote={remote}
          state={state}
          onEdit={(rule) => setEditing({ rule, isNew: false })}
        />
        <DestinationsPanel remote />
        <RecentAlerts />
      </div>
      <RuleDialog
        draft={editing}
        onClose={() => setEditing(null)}
        remote={{
          rules,
          disabled: state.disabled || conflict,
          reason: state.reason ?? draftReason,
          write: state.write,
          reload: state.reload,
        }}
      />
    </div>
  );
}

type RulesState = ReturnType<typeof useRemoteAlertRules>;

function RemoteRulesPanel({
  remote,
  state,
  onEdit,
}: {
  remote: RemoteHostRecord;
  state: RulesState;
  onEdit: (rule: AlertRule) => void;
}) {
  const { name } = remote.config;
  const { query, disabled, write } = state;
  const units = useSettings((s) => s.units);
  const lastAlert = useLastAlerts();
  const measured = useMeasuredMetrics();
  const [toggleError, setToggleError] = useState<string | null>(null);
  const rules = query.data?.rules ?? NO_RULES;
  const toggle = async (id: string, enabled: boolean) => {
    setToggleError(null);
    const result = await write(
      rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule))
    );
    if (!result.saved) setToggleError(result.error);
  };
  return (
    <SettingsPanel title="Rules" after={<RemoteRulesNotes remote={remote} />}>
      <RemoteRulesNotice remote={remote} state={state} />
      {toggleError && (
        <InlineMessage tone="error" className="px-4 py-3.5">
          {toggleError}
        </InlineMessage>
      )}
      {units &&
        rules.map((rule) => (
          <CustomRuleRow
            key={rule.id}
            rule={rule}
            units={units}
            measured={measured}
            lastAlert={lastAlert(rule.id)}
            notMeasured={`Not measured on ${name}`}
            disabled={disabled}
            onEnabledChange={(enabled) => void toggle(rule.id, enabled)}
            onEdit={() => onEdit(rule)}
          />
        ))}
      {query.data?.newer.map(({ id }, index) => (
        <SettingsRow
          key={id ?? `unreadable-${index}`}
          label="Made by a newer version"
        />
      ))}
    </SettingsPanel>
  );
}

function RemoteRulesNotice({
  remote,
  state,
}: {
  remote: RemoteHostRecord;
  state: RulesState;
}) {
  const { query, reason, reload } = state;
  const { name } = remote.config;
  const behind = hostsNeedingUpdate([remote]).length > 0;
  if (
    rulesAgentUnsupported(query.error) ||
    (behind && remote.status.agent_update.kind === "required")
  ) {
    return (
      <div className="flex items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex flex-col gap-1">
          {reason && <InlineMessage tone="status">{reason}</InlineMessage>}
          <InlineMessage tone="status">
            {behind
              ? `Update the agent on ${name} to set alerts`
              : remoteRulesErrorText(
                  query.error,
                  name,
                  "Couldn't load the rules."
                )}
          </InlineMessage>
        </div>
        {behind && (
          <HostCardActions
            model={remoteHostCardModel(remote)}
            remote={remote}
            connectionActions={false}
          />
        )}
      </div>
    );
  }
  if (reason) {
    return (
      <InlineMessage tone="status" className="px-4 py-3.5">
        {reason}
        {reload && <ReloadRulesButton action={reload} />}
      </InlineMessage>
    );
  }
  return (
    <QueryNotice
      query={query}
      className="px-4 py-3.5"
      loading="Loading rules…"
      error={(error) =>
        remoteRulesErrorText(error, name, "Couldn't load the rules.")
      }
      empty={
        query.data?.rules.length === 0 && query.data.newer.length === 0
          ? "No rules yet."
          : null
      }
    />
  );
}

function RemoteRulesNotes({ remote }: { remote: RemoteHostRecord }) {
  const { error } = useHistoryHealth();
  const healthError = error && historyUnavailable(error);
  const unavailable =
    healthError ??
    (remote.status.sync === "unavailable"
      ? historyUnavailable({ kind: "history_unavailable" })
      : null);
  return (
    <>
      <p className="m-0 text-label text-muted-foreground">
        Rules run on {remote.config.name}, and alerts reach you while this Mac
        is awake and connected.
      </p>
      {unavailable && (
        <HistoryUnavailableBanner message={unavailable.message} />
      )}
    </>
  );
}
