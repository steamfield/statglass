/**
 * First-launch screen: what the app is for and the three ways in (pair a Mac,
 * add a Linux server, try the demo hosts).
 */
import { ScrollView, Text, View } from "react-native";
import { ActionButton } from "@/components/action-button";
import { StartupFailurePanel } from "@/ui/startup-failure";

/** The app's opening screen before any host is paired. */
export default function FirstLaunch() {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="grow pt-safe pb-safe"
      contentInsetAdjustmentBehavior="never"
    >
      <View className="px-6">
        <StartupFailurePanel />
      </View>
      <View className="grow justify-center gap-3 px-6 py-4">
        <Text
          accessibilityRole="header"
          className="font-bold text-4xl text-foreground"
        >
          StatGlass
        </Text>
        <Text className="text-lg text-muted-foreground">
          Watch the Macs and Linux servers you monitor with StatGlass, live and
          with their history.
        </Text>
      </View>
      <View className="gap-3 px-6 pb-6">
        <ActionButton
          label="Pair with your Mac"
          href="/pair"
          weight="primary"
        />
        <ActionButton
          label="Add a Linux server"
          href="/pair-linux"
          weight="secondary"
        />
        <ActionButton label="Try demo hosts" href="/demo" weight="plain" />
      </View>
    </ScrollView>
  );
}
