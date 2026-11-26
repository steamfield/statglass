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
  const [samplers] = useState(() =>
    Object.fromEntries(
      DEMO_HOSTS.filter((h) => h.enabled).map((h) => [
        h.id,
        createHostSampler(h),
      ])
    )
  );
  const [state, setState] = useState<HostsState>(() => ({
    series: Object.fromEntries(
      DEMO_HOSTS.filter((h) => h.enabled).map((h) => [
        h.id,
        initialSeries(
          h,
          samplers[h.id] as ReturnType<typeof createHostSampler>
        ),
      ])
    ),
    tEndMs: 0,
  }));
  const ref = useOnScreenInterval(() =>
    setState((s) => ({
      series: Object.fromEntries(
        Object.entries(s.series).map(([id, series]) => [
          id,
          advance(
            series,
            (samplers[id] as ReturnType<typeof createHostSampler>)()
          ),
        ])
      ),
      tEndMs: Date.now(),
    }))
  );
  return { ref, ...state };
}
