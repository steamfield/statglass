import type { DemandLevel, HostId } from "@core/generated/types";

export type { DemandLevel } from "@core/generated/types";

/** Declares demand for `host` while the calling screen is focused (useFocusEffect); the union goes to the core. */
export function useFocusDemand(
  _host: HostId | null,
  _level: DemandLevel
): void {}

export function useVisibleHosts(): {
  onViewableItemsChanged(info: { viewableItems: { key: string }[] }): void;
} {
  return { onViewableItemsChanged: () => {} };
}
