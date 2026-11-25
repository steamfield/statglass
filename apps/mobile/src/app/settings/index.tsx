import { Stack, useCanGoBack, useRouter } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";

const SECTIONS = [
  { title: "Hosts", href: "/settings/hosts" },
  { title: "This iPhone", href: "/settings/device" },
  { title: "Data", href: "/settings/data" },
  { title: "Appearance", href: "/settings/appearance" },
  { title: "About", href: "/settings/about" },
] as const;

/** Settings section links. */
export default function SettingsIndex() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const colors = useThemeColors();
  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () =>
            canGoBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to Hosts"
                onPress={() => router.back()}
                className="min-h-[44px] min-w-[44px] items-center justify-center active:opacity-70"
              >
                <Svg
                  width={20}
                  height={20}
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke={colors.foreground}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <Path d="m12 4-6 6 6 6" />
                </Svg>
              </Pressable>
            ) : null,
        }}
      />
      <ScrollView
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View className="px-4 pt-2 pb-safe-or-4">
          <View className="overflow-hidden rounded-xl border border-border bg-card">
            {SECTIONS.map(({ title, href }, index) => (
              <Pressable
                key={href}
                accessibilityRole="button"
                accessibilityLabel={title}
                onPress={() => router.push(href)}
                className={`min-h-[44px] flex-row items-center justify-between gap-2 px-4 py-2 active:bg-secondary ${index ? "border-border-subtle border-t" : ""}`}
              >
                <Text role="body" className="shrink">
                  {title}
                </Text>
                <Svg
                  width={10}
                  height={14}
                  viewBox="0 0 10 14"
                  fill="none"
                  stroke={colors["muted-foreground"]}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  accessible={false}
                >
                  <Path d="m3 3 4 4-4 4" />
                </Svg>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </>
  );
}
