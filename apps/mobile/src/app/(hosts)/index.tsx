import { Stack, useRouter } from "expo-router";
import { useDemo } from "@/data/demo";
import { HostsList } from "@/hosts/hosts-list";
import { DemoBadge } from "@/ui/demo-badge";
import { HeaderButton } from "@/ui/header-button";

/** Wires the hosts list and its navigation bar. */
export default function HostsRoute() {
  const { active, exit } = useDemo();
  const router = useRouter();
  const settings = () => (
    <HeaderButton
      icon="gearshape"
      accessibilityLabel="Settings"
      onPress={() => router.push("/settings")}
    />
  );
  return (
    <>
      <Stack.Screen
        options={{
          headerShadowVisible: false,
          unstable_headerLeftItems: () =>
            active
              ? [
                  {
                    type: "custom",
                    hidesSharedBackground: true,
                    element: <DemoBadge onExit={exit} />,
                  },
                ]
              : [],
          headerRight: settings,
          unstable_headerRightItems: () => [
            {
              type: "custom",
              hidesSharedBackground: true,
              element: settings(),
            },
          ],
        }}
      />
      <HostsList
        onOpen={(host) =>
          router.push({ pathname: "/(hosts)/[host]", params: { host } })
        }
        onDemo={() => router.replace("/demo")}
        onPair={() => router.push("/pair")}
      />
    </>
  );
}
