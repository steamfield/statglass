import type { DockerSnapshot } from "@core/generated/bindings";
import { dockerKeys, sameDockerContainer } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { holdWhile } from "~/lib/queries/hold";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";
import {
  type DockerOpen,
  useDockerSubscription,
} from "./use-docker-subscription";

export function useDocker() {
  const transport = useTransport();
  const local = useIsLocalHost();
  const [snapshot, setSnapshot] = useState<DockerSnapshot | null>(null);
  const open = useCallback<DockerOpen<DockerSnapshot>>(
    (onSnapshot) => transport.dockerSubscribe(onSnapshot),
    [transport]
  );
  const error = useDockerSubscription(local ? open : null, (next) =>
    setSnapshot((previous) =>
      previous && previous.generation > next.generation ? previous : next
    )
  );
  return { snapshot: local ? snapshot : null, error, setSnapshot };
}

export function useDockerHistory(
  engine: string,
  container: string | null,
  from: number,
  to: number,
  generation = 0
) {
  const transport = useTransport();
  const local = useIsLocalHost();
  const host = useHostId();
  const queryKey = dockerKeys.history(
    host,
    engine,
    container,
    from,
    to,
    generation
  );
  return useQuery({
    queryKey,
    placeholderData: holdWhile(queryKey, sameDockerContainer),
    enabled: local && Boolean(engine),
    queryFn: () =>
      unwrap(
        transport.dockerHistory({
          engine_id: engine,
          container_id: container,
          from_ms: from,
          to_ms: to,
          max_points: 360,
        })
      ),
  });
}
export function useDockerEvents(
  engine: string,
  container: string | null,
  from: number,
  to: number,
  generation = 0,
  beforeId: string | null = null
) {
  const transport = useTransport();
  const local = useIsLocalHost();
  const host = useHostId();
  return useQuery({
    queryKey: dockerKeys.events(
      host,
      engine,
      container,
      from,
      to,
      generation,
      beforeId
    ),
    enabled: local && Boolean(engine),
    queryFn: () =>
      unwrap(
        transport.dockerEvents({
          engine_id: engine,
          container_id: container,
          from_ms: from,
          to_ms: to,
          limit: 200,
          before_id: beforeId,
        })
      ),
  });
}
