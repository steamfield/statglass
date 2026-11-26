import { useState } from "react";
import { TextInput } from "react-native";
import { Text } from "@/ui/text";
import { PairAction } from "./action";
import { PairingStep } from "./pairing-step";

const PAIRING_COPY = {
  label: "Pairing code",
  instructions: "Paste the full pairing text from the host.",
  empty: "Paste a pairing code to continue.",
  submit: "Preview host",
};

export function Paste({
  inspect,
  cancel,
  copy = PAIRING_COPY,
  checking = false,
}: {
  inspect(text: string): void;
  cancel(): void;
  copy?: typeof PAIRING_COPY;
  checking?: boolean;
}) {
  const [text, setText] = useState("");
  const [empty, setEmpty] = useState(false);

  function submit() {
    const code = text.trim();
    if (code) inspect(code);
    else setEmpty(true);
  }

  return (
    <PairingStep
      title="Paste code"
      explanation={copy.instructions}
      embedded={copy !== PAIRING_COPY}
      actions={
        <>
          <PairAction
            label={copy.submit}
            disabled={checking}
            onPress={submit}
          />
          <PairAction
            label="Cancel"
            secondary
            disabled={checking}
            onPress={cancel}
          />
        </>
      }
    >
      <TextInput
        accessibilityLabel={copy.label}
        value={text}
        editable={!checking}
        onChangeText={(value) => {
          setText(value);
          setEmpty(false);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        spellCheck={false}
        className="min-h-[88px] rounded-xl border border-input bg-card px-3 py-2 font-mono text-foreground"
      />
      {empty && (
        <Text variant="caption" accessibilityRole="alert" tone="destructive">
          {copy.empty}
        </Text>
      )}
    </PairingStep>
  );
}
