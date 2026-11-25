import { useState } from "react";
import { TextInput } from "react-native";
import { Text } from "@/ui/text";
import { PairAction } from "./action";

export function Paste({
  inspect,
  cancel,
}: {
  inspect(text: string): void;
  cancel(): void;
}) {
  const [text, setText] = useState("");
  const [empty, setEmpty] = useState(false);

  function submit() {
    const code = text.trim();
    if (code) inspect(code);
    else setEmpty(true);
  }

  return (
    <>
      <Text role="title">Paste code</Text>
      <Text role="body">Paste the full pairing text from the host.</Text>
      <TextInput
        accessibilityLabel="Pairing code"
        value={text}
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
        <Text
          role="caption"
          accessibilityRole="alert"
          className="text-destructive!"
        >
          Paste a pairing code to continue.
        </Text>
      )}
      <PairAction label="Preview host" onPress={submit} />
      <PairAction label="Cancel" secondary onPress={cancel} />
    </>
  );
}
