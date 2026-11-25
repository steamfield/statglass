import { nativeErrorText } from "@core/native-errors";
import { pairingAdvice } from "@core/remote-errors";
import type { PairingStep as FlowStep } from "@/pairing/flow";
import { Text } from "@/ui/text";
import { PairAction } from "./action";
import { PairingStep } from "./pairing-step";

export function PairingFailure({
  step,
  retry,
  done,
}: {
  step: Extract<FlowStep, { kind: "failed" }>;
  retry(): void;
  done(): void;
}) {
  const { error, host } = step;
  const { title, recovery } =
    "source" in error ? nativeErrorText(error) : pairingAdvice(error, host);
  const detail =
    error.kind === "pairing" && error.message !== title ? error.message : null;
  return (
    <PairingStep
      title={title}
      explanation={recovery}
      tone="warning"
      actions={
        <>
          <PairAction label="Try again" onPress={retry} />
          <PairAction label="Done" secondary onPress={done} />
        </>
      }
    >
      {detail && <Text variant="caption">{detail}</Text>}
    </PairingStep>
  );
}

export function PairingSuccess({ host, done }: { host: string; done(): void }) {
  return (
    <PairingStep
      title={`${host} is paired`}
      explanation="You can now view this host’s live metrics and history."
      actions={<PairAction label="View hosts" onPress={done} />}
    />
  );
}
