import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { SettingsScroll } from "./settings-scroll";

const CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export function AppearanceSettings() {
  const appearance = usePhoneSettings((s) => s.appearance);
  const { set } = usePhoneSettingsActions();
  return (
    <SettingsScroll>
      <GroupedList>
        {CHOICES.map(({ value, label }) => (
          <ListRow
            key={value}
            title={label}
            accessory="checkmark"
            selected={appearance === value}
            onPress={() => set({ appearance: value })}
          />
        ))}
      </GroupedList>
    </SettingsScroll>
  );
}
