import { Stack, useRouter } from "expo-router";
import { Pressable } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useIsDemo } from "@/data/transport-context";
import { HostsList } from "@/hosts/hosts-list";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";

/** Wires the hosts list and its navigation bar. */
export default function HostsRoute() {
  const demo = useIsDemo();
  const router = useRouter();
  const colors = useThemeColors();
  return (
    <>
      <Stack.Screen
        options={{
          headerShadowVisible: false,
          unstable_headerLeftItems: () =>
            demo
              ? [
                  {
                    type: "custom",
                    hidesSharedBackground: true,
                    element: <Text variant="label">Demo</Text>,
                  },
                ]
              : [],
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              onPress={() => router.push("/settings")}
              className="min-h-[44px] min-w-[44px] items-center justify-center active:opacity-70"
            >
              <Svg
                width={22}
                height={22}
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.foreground}
                strokeWidth={1.5}
                strokeLinecap="round"
              >
                <Circle cx={12} cy={12} r={6} />
                <Circle cx={12} cy={12} r={2} />
                <Path d="M12 4v2m0 12v2M4 12h2m12 0h2M6.3 6.3l1.5 1.5m8.4 8.4 1.5 1.5m0-11.4-1.5 1.5m-8.4 8.4-1.5 1.5" />
              </Svg>
            </Pressable>
          ),
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
