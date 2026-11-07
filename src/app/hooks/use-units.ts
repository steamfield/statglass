import { type DisplayUnits, displayUnits } from "@core/format";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "~/stores/settings-store";

/** The Units settings as the formatters' option values (`displayUnits`). */
export function useUnits(): DisplayUnits {
  return useStore(
    useSettingsStore(),
    useShallow((s) => displayUnits(s.snapshot?.settings.units ?? null))
  );
}
