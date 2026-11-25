import { remoteErrorText } from "@core/remote-errors";
import { createElement, Fragment, type JSX } from "react";
import { ScrollView, Text, View } from "react-native";
import { ActionButton } from "@/components/action-button";
import { useNativeCore } from "@/transport";
import { RetryPanel } from "@/ui/retry-panel";
import { StartupFailurePanel } from "@/ui/startup-failure";

export function WelcomeScreen(): JSX.Element {
  const { error, retry } = useNativeCore();
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="grow pt-safe pb-safe"
      contentInsetAdjustmentBehavior="never"
    >
      {error && (
        <View className="px-6">
          {"source" in error ? (
            <StartupFailurePanel />
          ) : (
            <RetryPanel
              title="StatGlass couldn’t start"
              detail={remoteErrorText(error)}
              retry={retry}
            />
          )}
        </View>
      )}
      <View className="grow justify-center gap-3 px-6 py-4">
        <Text
          accessibilityRole="header"
          className="font-semibold text-4xl text-foreground"
        >
          StatGlass
        </Text>
        <Text className="text-lg text-muted-foreground">
          Watch the Macs and Linux servers you monitor with StatGlass, live and
          with their history.
        </Text>
      </View>
      <View className="gap-3 px-6 pb-6">
        {!error && (
          <ActionButton label="Add a host" href="/pair" weight="primary" />
        )}
        <ActionButton label="Try demo hosts" href="/demo" weight="secondary" />
      </View>
    </ScrollView>
  );
}

export function ExamplePreview(_props: { focused: boolean }): JSX.Element {
  return createElement(Fragment);
}
