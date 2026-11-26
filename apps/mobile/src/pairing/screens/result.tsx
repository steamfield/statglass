import { nativeErrorText } from "@core/native-errors";
import { pairingAdvice } from "@core/remote-errors";
import type { PairingStep as FlowStep } from "@/pairing/flow";
import { Button } from "@/ui/button";
import { Text } from "@/ui/text";
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
          <Button label="Try again" onPress={retry} />
          <Button label="Done" variant="secondary" onPress={done} />
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
      actions={<Button label="View hosts" onPress={done} />}
    />
  );
}
