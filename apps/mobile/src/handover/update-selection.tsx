import { commandErrorText } from "@core/command-error";
import type {
  BundleReconcile,
  HostId,
  HostRecord,
} from "@core/generated/types";
import { useState } from "react";
import { View } from "react-native";
import { usePhoneSettings } from "@/data/phone-settings";
import { PairAction } from "@/pairing/screens/action";
import { Text } from "@/ui/text";
import {
  type HandoverTransport,
  useApplyHandover,
  useRemoveHandoverHost,
} from "./apply";
import { HostChoices, UnavailableHosts, useHostSelection } from "./choices";

export function UpdateSelection({
  core,
  diff,
  roster,
  cancel,
  done,
}: {
  core: HandoverTransport;
  diff: BundleReconcile;
  roster: HostRecord[];
  cancel(): void;
  done(applied: boolean): void;
}) {
  const names = usePhoneSettings((settings) => settings.hostNames);
  const { excluded, selected, toggle } = useHostSelection(diff.new);
  const [removed, setRemoved] = useState(diff.removed);
  const apply = useApplyHandover(core, diff.preview_id);
  const remove = useRemoveHandoverHost(core);
  const busy = apply.isPending || remove.isPending;
  const hasDiff =
    diff.new.length + diff.changed.length + diff.removed.length > 0;
  const hasChanges =
    selected.length + diff.changed.length + diff.removed.length > 0;
  const applied = apply.isSuccess;
  const error = apply.error ?? remove.error;
  const hostName = (id: HostId) =>
    names[id] ?? roster.find((host) => host.id === id)?.display_name ?? id;

  return (
    <>
      <Text variant="title">
        {applied ? "Hosts updated" : "Review host updates"}
      </Text>
      {!hasDiff && (
        <Text variant="body">There are no host changes to apply.</Text>
      )}
      {!applied && diff.new.length > 0 && (
        <>
          <Text variant="label">Add hosts</Text>
          <HostChoices
            hosts={diff.new}
            excluded={excluded}
            disabled={busy}
            toggle={toggle}
          />
        </>
      )}
      {!applied && diff.changed.length > 0 && (
        <View className="gap-2">
          <Text variant="label">Changes to existing hosts</Text>
          {diff.changed.map((id) => (
            <Text key={id} variant="body">
              {hostName(id)}
            </Text>
          ))}
        </View>
      )}
      {removed.map((id) => (
        <View
          key={id}
          className="gap-2 rounded-xl border border-border bg-card p-4"
        >
          <Text variant="body">{hostName(id)}</Text>
          <Text variant="caption">Removed on your Mac</Text>
          {applied && (
            <PairAction
              label={
                remove.isPending && remove.variables === id
                  ? "Removing…"
                  : `Remove ${hostName(id)}`
              }
              secondary
              disabled={busy}
              onPress={() =>
                remove.mutate(id, {
                  onSuccess: () =>
                    setRemoved((hosts) => hosts.filter((host) => host !== id)),
                })
              }
            />
          )}
        </View>
      ))}
      <UnavailableHosts hosts={diff.unavailable} />
      {error && (
        <Text variant="body" accessibilityRole="alert" tone="destructive">
          {commandErrorText(
            error,
            "Couldn’t save the host changes. Try again."
          )}
        </Text>
      )}
      {applied || !hasDiff ? (
        <PairAction
          label="Done"
          disabled={busy}
          onPress={() => done(applied)}
        />
      ) : (
        <>
          <PairAction
            label={apply.isPending ? "Applying…" : "Apply updates"}
            disabled={busy || !hasChanges}
            onPress={() => apply.mutate(selected)}
          />
          <PairAction
            label="Cancel"
            secondary
            disabled={busy}
            onPress={cancel}
          />
        </>
      )}
    </>
  );
}
