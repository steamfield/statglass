import { Text } from "@/ui/text";
import { PairAction } from "./action";
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
      actions={<PairAction label="Cancel" secondary onPress={cancel} />}
    >
      <Text variant="heroFigure">{code}</Text>
    </PairingStep>
  );
}
