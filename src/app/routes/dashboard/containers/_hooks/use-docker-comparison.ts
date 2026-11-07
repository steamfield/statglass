import type { DockerComparisonRequest } from "@core/generated/bindings";
import { dockerKeys, sameDockerEngine } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { holdWhile } from "~/lib/queries/hold";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";
export function useDockerComparison(
  request: DockerComparisonRequest,
  generation: number
) {
  const transport = useTransport();
  const local = useIsLocalHost();
  const host = useHostId();
  const queryKey = dockerKeys.comparison(
    host,
    request.engine_id,
    request.from_ms,
    request.to_ms,
    request.metric,
    request.project,
    request.selected,
    generation
  );
  return useQuery({
    queryKey,
    placeholderData: holdWhile(queryKey, sameDockerEngine),
    enabled: local && Boolean(request.engine_id),
    queryFn: () => unwrap(transport.dockerComparison(request)),
  });
}
