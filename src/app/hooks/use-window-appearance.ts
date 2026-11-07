import type { Appearance } from "@core/generated/bindings";
import { isPerformanceOn } from "@core/performance";
import { useEffect, useLayoutEffect, useState } from "react";
import { useWindowAppearanceFlags } from "~/lib/queries/appearance";
import { useSettings } from "~/stores/settings-store";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Whether `.dark` belongs on <html> for an appearance and the OS scheme. */
export function resolveDark(appearance: Appearance, systemDark: boolean) {
  if (appearance === "system") return systemDark;
  return appearance === "dark";
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/**
 * Reflect the window's appearance on <html> (design-system.md "Themes",
 * "Vibrant surfaces", "Motion"): `.dark` from the Appearance setting (Match
 * system follows `prefers-color-scheme`), and `data-performance` /
 * `data-reduce-transparency` from `get_window_appearance` and its event.
 * `override` pins the theme (the gallery's `?theme=`).
 */
export function useWindowAppearance(override?: "light" | "dark" | null) {
  const appearance = useSettings((s) => s.general.appearance) ?? "system";
  const systemDark = useSystemDark();
  const flags = useWindowAppearanceFlags().data;

  const dark = override
    ? override === "dark"
    : resolveDark(appearance, systemDark);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.toggleAttribute(
      "data-performance",
      isPerformanceOn(flags?.performance)
    );
    root.toggleAttribute(
      "data-reduce-transparency",
      flags?.reduce_transparency ?? false
    );
  }, [dark, flags]);
}
