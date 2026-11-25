import { commandErrorText } from "@core/command-error";
import { useState } from "react";
import { Clipboard, View } from "react-native";
import { usePhonePublicKey } from "@/data/pairing-context";
import { AppLockSetting } from "@/lock/app-lock-setting";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { RetryPanel } from "@/ui/retry-panel";
import { Text } from "@/ui/text";
import { SettingsScroll } from "./settings-scroll";

export function DeviceSettings() {
  const { available, result, retry } = usePhonePublicKey();
  const key = result && "key" in result ? result.key : null;
  const [copyFeedback, setCopyFeedback] = useState<{
    key: string;
    error: string | null;
  } | null>(null);

  function copy(key: string) {
    try {
      Clipboard.setString(key);
      setCopyFeedback({ key, error: null });
    } catch (error) {
      setCopyFeedback({
        key,
        error: commandErrorText(error, "Couldn’t copy the public key."),
      });
    }
  }

  const feedback = copyFeedback?.key === key ? copyFeedback : null;
  return (
    <SettingsScroll>
      <ListSection title="Public key">
        {key ? (
          <GroupedList>
            <View className="px-4 py-3">
              <Text
                variant="caption"
                className="font-mono"
                maxFontSizeMultiplier={1.5}
                selectable
              >
                {key}
              </Text>
            </View>
            <ListRow
              title={feedback && !feedback.error ? "Copied" : "Copy"}
              glyph="doc.on.doc"
              onPress={() => copy(key)}
            />
          </GroupedList>
        ) : result && "error" in result ? (
          <RetryPanel
            title="Couldn’t read the public key"
            detail={result.error}
            retry={retry}
          />
        ) : (
          <GroupedList>
            <ListRow
              title={
                available ? "Loading public key…" : "Available after pairing"
              }
            />
          </GroupedList>
        )}
        {feedback?.error && (
          <Text variant="caption" accessibilityRole="alert" className="px-4">
            {feedback.error}
          </Text>
        )}
      </ListSection>
      <AppLockSetting />
    </SettingsScroll>
  );
}
