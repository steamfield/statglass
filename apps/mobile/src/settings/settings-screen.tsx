import { useRouter } from "expo-router";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { SettingsScroll } from "./settings-scroll";

const SECTIONS = [
  { title: "Hosts", href: "/settings/hosts" },
  { title: "This iPhone", href: "/settings/device" },
  { title: "Data", href: "/settings/data" },
  { title: "Appearance", href: "/settings/appearance" },
  { title: "About", href: "/settings/about" },
] as const;

export function SettingsScreen() {
  const router = useRouter();
  return (
    <SettingsScroll>
      <GroupedList>
        {SECTIONS.map(({ title, href }) => (
          <ListRow
            key={href}
            title={title}
            accessory="chevron"
            onPress={() => router.push(href)}
          />
        ))}
      </GroupedList>
    </SettingsScroll>
  );
}
