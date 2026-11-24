/**
 * First-launch screen: what the app is for and the three ways in (pair a Mac,
 * add a Linux server, try the demo hosts).
 */
import { Text, View } from "react-native";
import { ActionButton } from "../components/action-button";
import { SafeAreaView } from "../components/styled";

/** The app's opening screen before any host is paired. */
export default function FirstLaunch() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-3 px-6">
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
    </SafeAreaView>
  );
}
