import { useIsFocused, useRouter } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";
import { useDemo } from "@/data/demo";
import { PairAction } from "@/pairing/screens/action";
import { useNativeCore } from "@/transport";
import { ScreenScroll } from "@/ui/screen-scroll";
import { StartupFailurePanel } from "@/ui/startup-failure";
import { Text } from "@/ui/text";
import { ExamplePreview } from "./example-preview";

export { ExamplePreview } from "./example-preview";

export function WelcomeScreen(): JSX.Element {
  const router = useRouter();
  const focused = useIsFocused();
  const { start } = useDemo();
  const { error } = useNativeCore();
  return (
    <ScreenScroll
      headerShown={false}
      className="flex-1 bg-background"
      contentContainerClassName="grow justify-center gap-4 px-6 py-4"
    >
      <View className="gap-2">
        <Text variant="onboardingTitle">StatGlass</Text>
        <ExamplePreview focused={focused} />
      </View>
      <Text variant="body">
        StatGlass shows your Macs&apos; and servers&apos; CPU, memory, power and
        network, live, from this iPhone.
      </Text>
      {error && <StartupFailurePanel />}
      <View className="gap-2">
        {!error && (
          <PairAction label="Add a host" onPress={() => router.push("/pair")} />
        )}
        <PairAction label="Try demo hosts" secondary onPress={() => start()} />
      </View>
    </ScreenScroll>
  );
}
