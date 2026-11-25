import { nativeErrorText } from "@core/native-errors";
import { pairingAdvice } from "@core/remote-errors";
import type { PairingStep } from "@/pairing/flow";
import { Text } from "@/ui/text";
import { PairAction } from "./action";

export function PairingFailure({
  step,
  retry,
  done,
}: {
  step: Extract<PairingStep, { kind: "failed" }>;
  retry(): void;
  done(): void;
}) {
  const { error, host } = step;
  const { title, recovery } =
    "source" in error ? nativeErrorText(error) : pairingAdvice(error, host);
  const detail =
    error.kind === "pairing" && error.message !== title ? error.message : null;
  return (
    <>
      <Text role="title" accessibilityRole="alert">
        {title}
      </Text>
      {detail && <Text role="caption">{detail}</Text>}
      <Text role="body">{recovery}</Text>
      <PairAction label="Try again" onPress={retry} />
      <PairAction label="Done" secondary onPress={done} />
    </>
  );
}

export function PairingSuccess({ host, done }: { host: string; done(): void }) {
  return (
    <>
      <Text role="title">{host} is paired</Text>
      <PairAction label="View hosts" onPress={done} />
    </>
  );
}
