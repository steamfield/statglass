import { errorTone } from "@core/command-error";
import { formatClock } from "@core/format";
import type { DockerSnapshot } from "@core/generated/bindings";
import { brushScopeProps } from "~/components/brush-overlay";
import { InlineMessage } from "~/components/inline-message";
import { SectionCard } from "~/components/section-card";
import { SelectionChip } from "~/components/selection-chip";
import { useSearchParamPatch } from "~/hooks/use-search-param-patch";
import { useBrushRange } from "~/stores/brush-store";
import type { useContainerComparison } from "../_hooks/use-container-comparison";
import {
  type ContainerSort,
  dockerErrorMessage,
  filterContainers,
} from "../_lib/presentation";
import type { ContainerRouteState } from "../_lib/route-state";
import { ContainerFilters } from "./container-filters";
import { ContainerTable, needsAttention } from "./container-table";

export function ContainerResults({
  snapshot,
  route,
  chart,
  set,
  onSort,
}: {
  snapshot: DockerSnapshot;
  route: ContainerRouteState;
  chart: ReturnType<typeof useContainerComparison>;
  set: (key: string, value: string | null) => void;
  onSort: (sort: ContainerSort) => void;
}) {
  const {
    project,
    query,
    state,
    sort,
    grouped,
    columns,
    collapsed,
    end,
    from,
    to,
  } = route;
  const {
    ranking,
    selectedComparison,
    slots,
    pinnedFocus,
    focused,
    setFocused,
  } = chart;
  const patch = useSearchParamPatch();
  const engine = snapshot.engine?.id ?? "";
  const selection = useBrushRange();
  const scopeRows = snapshot.containers.filter(
    (row) => project === null || (row.project ?? "") === project
  );
  const historical = end !== null || selection !== null;
  const tableRanking = selection
    ? selectedComparison.data?.ranking.filter(
        (row) => row.container.engine_id === engine
      )
    : ranking;
  const tableRows = historical
    ? (tableRanking ?? []).map((r) => ({
        ...r.container,
        lifecycle: r.last_lifecycle ?? ("unknown" as const),
        metrics: {
          ...r.container.metrics,
          cpu_pct: r.peak_cpu_pct,
          working_set_bytes: r.peak_working_set_bytes,
        },
      }))
    : scopeRows;
  const shown = filterContainers(tableRows, query, state);
  const hiddenAttention = tableRows.filter(
    (row) =>
      needsAttention(row) && !shown.some((visible) => visible.id === row.id)
  );
  const filters = (
    <ContainerFilters
      query={query}
      state={state}
      grouped={grouped}
      columns={columns}
      set={set}
    />
  );
  return (
    <div {...brushScopeProps}>
      {selection && selectedComparison.error && (
        <InlineMessage tone={errorTone(selectedComparison.error)}>
          Selected history could not be read:{" "}
          {dockerErrorMessage(selectedComparison.error)}
        </InlineMessage>
      )}
      <SectionCard accent="cpu" title="Containers now" hiddenTitle flush>
        <ContainerTable
          liveRows={snapshot.containers}
          rows={shown}
          sort={sort}
          onSort={(value) => {
            onSort(value);
          }}
          grouped={grouped}
          columns={columns}
          collapsed={collapsed}
          onCollapse={(group) =>
            patch({
              collapsed: collapsed.includes(group)
                ? collapsed.filter((g) => g !== group)
                : [...collapsed, group],
            })
          }
          slots={slots}
          focused={pinnedFocus ?? focused}
          onFocus={setFocused}
          filters={
            <>
              {selection && <SelectionChip range={selection} />}
              {filters}
            </>
          }
          historical={historical}
          summaries={historical ? tableRanking : undefined}
          title={
            historical
              ? `Containers · ${formatClock(selection?.fromMs ?? from)}–${formatClock(selection?.toMs ?? to)}`
              : "Containers now"
          }
          attention={
            hiddenAttention.length ? (
              <button
                type="button"
                className="text-[11px] underline"
                onClick={() => {
                  const target = hiddenAttention[0]?.project ?? "Standalone";
                  patch({
                    q: null,
                    state: null,
                    collapsed: collapsed.filter((group) => group !== target),
                  });
                  setFocused(hiddenAttention[0]?.id ?? null);
                }}
              >
                {hiddenAttention.length} need attention
              </button>
            ) : undefined
          }
        />
      </SectionCard>
    </div>
  );
}
