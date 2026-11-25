/**
 * The hosts the phone shows: the transport's host list in the user's order,
 * with phone-side names applied and removed hosts left out.
 */
import type { HostId, HostRecord } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { type PhoneSettings, usePhoneSettings } from "./phone-settings";
import { useIsDemo, usePhoneTransport } from "./transport-context";

export function useHostsPairingState() {
  const transport = usePhoneTransport();
  const demo = useIsDemo();
  const focused = useIsFocused();
  return useQuery({
    queryKey: hostKeys.pairing(),
    queryFn: () => unwrap(transport.pairingState()),
    enabled: !demo && focused,
  });
}

/** A phone-side filter can hide a host without removing it from the registry. */
export function useNativeRosterEmptied() {
  const transport = usePhoneTransport();
  const demo = useIsDemo();
  const [seenHosts, setSeenHosts] = useState(false);
  const count = useQuery({
    queryKey: hostKeys.list(),
    queryFn: () => transport.listHosts(),
    select: (hosts) => hosts.length,
    enabled: !demo,
  });
  useEffect(() => {
    if (demo || !count.isSuccess) return;
    if (count.data > 0) setSeenHosts(true);
  }, [count.data, count.isSuccess, demo]);
  return !demo && count.isSuccess && count.data === 0 && seenHosts;
}

/** The settings that decide which hosts show, in what order, under what name. */
export type HostListSettings = Pick<
  PhoneSettings,
  "hostOrder" | "hostNames" | "removed"
>;

/**
 * `hosts` without the removed ones, those in `hostOrder` first in that
 * order and the rest after in their list order, each named by its phone
 * rename when it has one.
 */
export function arrangeHosts(
  hosts: readonly HostRecord[],
  { hostOrder, hostNames, removed }: HostListSettings
): HostRecord[] {
  const rank = new Map<HostId, number>(hostOrder.map((id, i) => [id, i]));
  const shown = hosts.filter((host) => !removed.includes(host.id));
  const ranked = shown
    .map((host, listIndex) => ({
      host,
      key: rank.get(host.id) ?? hostOrder.length + listIndex,
    }))
    .sort((a, b) => a.key - b.key);
  return ranked.map(({ host }) => {
    const name = hostNames[host.id];
    return name === undefined ? host : { ...host, display_name: name };
  });
}

/** The phone's hosts list from `listHosts`, arranged by the phone settings. */
export function useHosts(): UseQueryResult<HostRecord[]> {
  const transport = usePhoneTransport();
  const hostOrder = usePhoneSettings((s) => s.hostOrder);
  const hostNames = usePhoneSettings((s) => s.hostNames);
  const removed = usePhoneSettings((s) => s.removed);
  const select = useCallback(
    (hosts: HostRecord[]) =>
      arrangeHosts(hosts, { hostOrder, hostNames, removed }),
    [hostOrder, hostNames, removed]
  );
  return useQuery({
    queryKey: hostKeys.list(),
    queryFn: () => transport.listHosts(),
    select,
  });
}
