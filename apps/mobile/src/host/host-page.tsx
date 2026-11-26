import type { HostRecord } from "@core/generated/types";
import { phoneProblem } from "@core/phone-connection";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { ProblemBanner } from "@/connection/problem-banner";
import { useHostConnection } from "@/data/hosts";
import { connectionStatusError, useConnection } from "@/data/live";
import { CardStack } from "./card-stack";
import { ConnectionPill } from "./connection-pill";

/** One host in the pager, with its connection status and popover cards. */
export function HostPage({
  host,
  width,
  active,
  onLayout,
}: {
  host: HostRecord;
  width: number;
  active: boolean;
  onLayout(event: LayoutChangeEvent): void;
}) {
  const status = useHostConnection(host.id, active && !host.is_local);
  const record = status.isError ? null : status.data;
  const problem = record
    ? phoneProblem({
        ...record,
        config: { ...record.config, name: host.display_name },
      })
    : null;
  const connection = useConnection(
    host.id,
    record?.status,
    !host.is_local && status.isError
      ? connectionStatusError(status.error)
      : null
  );
  const dimmed =
    connection.state === "offline" || connection.state === "reconnecting";
  return (
    <View
      className="px-4"
      style={[styles.content, { width }]}
      onLayout={onLayout}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
    >
      <ConnectionPill
        host={host.id}
        connection={connection}
        status={record?.status}
        active={active}
      />
      {problem && (
        <ProblemBanner
          key={`${host.id}:${problem.kind}`}
          host={host.id}
          problem={problem}
        />
      )}
      <CardStack host={host} dimmed={dimmed} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 12,
    paddingBottom: 20,
    paddingTop: 8,
  },
});
