import { Button } from "@/ui/button";
import { Text } from "@/ui/text";
import { PairingStep } from "./pairing-step";

export function Waiting({
  host,
  code,
  cancel,
}: {
  host: string;
  code: string;
  cancel(): void;
}) {
  return (
    <PairingStep
      title={`Waiting for approval on ${host}`}
      explanation="Compare this code with the one shown on the host."
      actions={<Button label="Cancel" variant="secondary" onPress={cancel} />}
    >
      <Text variant="heroFigure">{code}</Text>
    </PairingStep>
  );
}
