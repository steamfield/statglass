import { useIsFocused, useRouter } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";
import { useDemo } from "@/session/demo";
import { useNativeCore } from "@/transport";
import { Button } from "@/ui/button";
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
          <Button label="Add a host" onPress={() => router.push("/pair")} />
        )}
        <Button
          label="Try demo hosts"
          variant="secondary"
          onPress={() => start()}
        />
      </View>
    </ScreenScroll>
  );
}
