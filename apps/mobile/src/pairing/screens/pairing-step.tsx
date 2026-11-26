import type { Tone } from "@core/phone-connection";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";

export interface PairingStepProps {
  title: string;
  explanation?: string;
  children?: ReactNode;
  actions: ReactNode;
  tone?: Tone;
  /** Paste and Scanner also render inside the Update from Mac screen's scroll view. */
  embedded?: boolean;
}

export function PairingStep({
  title,
  explanation,
  children,
  actions,
  tone,
  embedded = false,
}: PairingStepProps) {
  const { bottom } = useSafeAreaInsets();
  const heading = (
    <>
      <Text
        variant={embedded ? "title" : "onboardingTitle"}
        accessibilityRole={tone ? "alert" : "header"}
        tone={tone === "warning" ? "warning" : undefined}
      >
        {title}
      </Text>
      {explanation && <Text variant="body">{explanation}</Text>}
    </>
  );
  if (embedded) {
    return (
      <>
        {heading}
        {children}
        {actions}
      </>
    );
  }
  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <ScreenScroll
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-4"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-2">{heading}</View>
        {children}
      </ScreenScroll>
      <View
        className="gap-2 px-6 pt-2"
        style={{ paddingBottom: Math.max(bottom, 16) }}
      >
        {actions}
      </View>
    </KeyboardAvoidingView>
  );
}
