import { commandErrorText, errorTone } from "@core/command-error";
import type { HostId, ProcessSort, ProcessView } from "@core/generated/types";
import { useHostLive, useHostLiveStream } from "@/data/live";
import {
  PROCESS_COLUMNS,
  processColumnAvailable,
  useLiveProcesses,
  useProcessDemand,
} from "@/data/processes";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";
import { ModuleNotice } from "./module-notice";

export function LiveProcessTable({
  host,
  sort,
  view,
}: {
  host: HostId;
  sort: ProcessSort;
  view: ProcessView;
}) {
  const supported = useHostLive(host, ({ capabilities }) =>
    processColumnAvailable(sort, capabilities)
  );
  const awaitingFrame = useHostLive(
    host,
    ({ statusSinceMs }) => statusSinceMs === null
  );
  const stream = useHostLiveStream(host);
  const error = useProcessDemand(host, supported ? view : null);
  const { rows, available } = useLiveProcesses(host, sort);
  const column = PROCESS_COLUMNS[sort];
  return (
    <ListSection title="Live processes">
      {!supported ? (
        <Text variant="label">
          {column.label} measurements are not available from this host.
        </Text>
      ) : error ? (
        <ModuleNotice
          error={errorTone(error) === "error"}
          message={`Couldn’t load live processes. ${commandErrorText(error, "Please try again.")}`}
        />
      ) : available && rows && rows.length > 0 ? (
        <GroupedList>
          {rows.map(({ key, name, figures }) => (
            <ListRow
              key={key}
              title={name}
              value={column.format(column.value(figures))}
              accessibilityHint={column.label}
            />
          ))}
        </GroupedList>
      ) : (
        <Text variant="label">
          {awaitingFrame && stream !== null
            ? "Waiting for live processes…"
            : "Processes are not available from this host"}
        </Text>
      )}
    </ListSection>
  );
}
