import { Text } from "@/ui/text";
import { PairAction } from "./action";

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
    <>
      <Text variant="title">Waiting for approval on {host}</Text>
      <Text variant="body">
        Compare this code with the one shown on the host.
      </Text>
      <Text variant="cardFigure">{code}</Text>
      <PairAction label="Cancel" secondary onPress={cancel} />
    </>
  );
}
