import { useState } from "react";
import { useOnScreenInterval } from "@/lib/use-on-screen-interval";
import {
  advance,
  createHostSampler,
  DEMO_HOSTS,
  type HostSeries,
  initialSeries,
} from "./phone-data";

type HostsState = { series: Record<string, HostSeries>; tEndMs: number };

/**
 * Every enabled demo host's series, one second apart, advancing while the
 * phone is on screen and the tab is visible. Reduced motion holds the first
 * frame (`useOnScreenInterval`).
 */
export function usePhoneHosts() {
  const [hosts] = useState(() =>
    DEMO_HOSTS.filter((h) => h.enabled).map((h) => {
      const next = createHostSampler(h);
      return { id: h.id, next, first: initialSeries(h, next) };
    })
  );
  const [state, setState] = useState<HostsState>(() => ({
    series: Object.fromEntries(hosts.map((h) => [h.id, h.first])),
    tEndMs: 0,
  }));
  const ref = useOnScreenInterval(() =>
    setState((s) => ({
      series: Object.fromEntries(
        hosts.map((h) => {
          const series = s.series[h.id] ?? h.first;
          return [h.id, advance(series, h.next())];
        })
      ),
      tEndMs: Date.now(),
    }))
  );
  return { ref, ...state };
}
