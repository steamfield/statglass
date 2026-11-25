import type { DemandLevel, HostDemand, HostId } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { useFocusEffect } from "expo-router";
import { createContext, useCallback, useId, useState } from "react";
import type { PhoneTransport } from "./seam";
import { usePhoneTransport } from "./transport-context";

export type { DemandLevel } from "@core/generated/types";

// Focused screen                               | Demand
// Hosts list                                   | Compact for viewable rows
// Host pager                                   | Full for the current page
// Module                                       | Full for its host
// Settings, pairing, welcome, demo and debug   | None
export const PagerHost = createContext<HostId | null>(null);
export const RowVisibility = createContext<{
  visible: boolean;
  width: number;
  refresh?: number;
} | null>(null);

class ScreenDemand {
  readonly entries = new Map<string, HostDemand>();
  private sent: HostDemand[] | null = [];
  private frame: number | null = null;
  private sending = false;
  private revision = 0;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly transport: PhoneTransport) {}

  schedule() {
    this.revision += 1;
    this.failures = 0;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.arm();
  }

  private arm() {
    if (this.frame !== null || this.sending) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      void this.flush();
    });
  }

  private async flush() {
    const revision = this.revision;
    const hosts = new Map<HostId, DemandLevel>();
    for (const { host, level } of this.entries.values()) {
      if (hosts.get(host) !== "full") hosts.set(host, level);
    }
    const demand = [...hosts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([host, level]) => ({ host, level }));
    const sent = this.sent;
    if (
      sent !== null &&
      demand.length === sent.length &&
      demand.every(
        ({ host, level }, i) =>
          host === sent[i]?.host && level === sent[i]?.level
      )
    )
      return;

    this.sending = true;
    try {
      await unwrap(this.transport.setDemand(demand));
      this.sent = demand;
      this.failures = 0;
    } catch (error) {
      this.sent = null;
      if (revision === this.revision) {
        if (this.failures === 0)
          console.warn("Could not update visible host demand", error);
        const delay = 250 * 2 ** Math.min(this.failures, 4);
        this.failures += 1;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.arm();
        }, delay);
      }
    } finally {
      this.sending = false;
      if (revision !== this.revision) this.arm();
    }
  }
}

const stores = new WeakMap<PhoneTransport, ScreenDemand>();

/** Declares demand while the calling screen is focused. Native lifecycle parks it in the background. */
export function useFocusDemand(host: HostId | null, level: DemandLevel): void {
  const transport = usePhoneTransport();
  const id = useId();
  useFocusEffect(
    useCallback(() => {
      if (host === null) return;
      let store = stores.get(transport);
      if (!store) {
        store = new ScreenDemand(transport);
        stores.set(transport, store);
      }
      const current = store;
      current.entries.set(id, { host, level });
      current.schedule();
      return () => {
        current.entries.delete(id);
        current.schedule();
      };
    }, [host, id, level, transport])
  );
}

export function useVisibleHosts() {
  const [visible, setVisible] = useState<ReadonlySet<HostId>>(() => new Set());
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { key: string }[] }) =>
      setVisible(new Set(viewableItems.map(({ key }) => key))),
    []
  );
  return { visible, onViewableItemsChanged };
}
