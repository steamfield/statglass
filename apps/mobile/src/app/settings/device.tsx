import { commandErrorText } from "@core/command-error";
import { useState } from "react";
import { Pressable, ScrollView, Share, View } from "react-native";
import { usePhonePublicKey } from "@/data/pairing-context";
import { AppLockSetting } from "@/lock/app-lock-setting";
import { RetryPanel } from "@/ui/retry-panel";
import { Text } from "@/ui/text";

/** Shows the phone's pairing state and its app lock. */
export default function DeviceSettings() {
  const { available, result, retry } = usePhonePublicKey();
  const key = result && "key" in result ? result.key : null;
  const [shareError, setShareError] = useState<string | null>(null);

  async function copy() {
    if (!key) return;
    setShareError(null);
    try {
      await Share.share({ message: key });
    } catch (error) {
      setShareError(commandErrorText(error, "Couldn’t open the share sheet."));
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-3 px-4 pt-2 pb-safe-or-4">
        {key ? (
          <View className="gap-2 rounded-xl border border-border bg-card p-4">
            <Text variant="cardTitle">Public key</Text>
            <Text variant="caption" className="font-mono" selectable>
              {key}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={copy}
              className="min-h-[44px] min-w-[44px] justify-center self-start px-2 active:opacity-70"
            >
              <Text variant="body" className="text-link">
                Copy
              </Text>
            </Pressable>
            {shareError && (
              <Text variant="caption" accessibilityRole="alert">
                {shareError}
              </Text>
            )}
          </View>
        ) : result && "error" in result ? (
          <RetryPanel
            title="Couldn’t read the public key"
            detail={result.error}
            retry={retry}
          />
        ) : (
          <Text variant="body">
            {available ? "Loading public key…" : "Available after pairing"}
          </Text>
        )}
        <AppLockSetting />
      </View>
    </ScrollView>
  );
}
