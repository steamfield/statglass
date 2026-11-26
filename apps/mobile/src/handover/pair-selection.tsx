import { commandErrorText } from "@core/command-error";
import type { PairedHost } from "@core/generated/types";
import { PairAction } from "@/pairing/screens/action";
import { Text } from "@/ui/text";
import { type HandoverTransport, useApplyHandover } from "./apply";
import { HostChoices, UnavailableHosts, useHostSelection } from "./choices";

export function PairSelection({
  core,
  offer,
  done,
}: {
  core: HandoverTransport;
  offer: PairedHost;
  done(): void;
}) {
  const { excluded, selected, toggle } = useHostSelection(offer.offered);
  const apply = useApplyHandover(core);
  const count = offer.offered.length;

  return (
    <>
      <Text variant="title">Also on {offer.name}</Text>
      {count > 0 && (
        <Text variant="body">
          {count === 1
            ? "Also add the host this Mac monitors."
            : `Also add the ${count} hosts this Mac monitors.`}
        </Text>
      )}
      <HostChoices
        hosts={offer.offered}
        excluded={excluded}
        disabled={apply.isPending}
        toggle={toggle}
      />
      <UnavailableHosts hosts={offer.unavailable} />
      {apply.isError && (
        <Text variant="body" accessibilityRole="alert" tone="destructive">
          {commandErrorText(apply.error, "Couldn’t add the hosts. Try again.")}
        </Text>
      )}
      {count > 0 && (
        <PairAction
          label={apply.isPending ? "Adding…" : "Add"}
          disabled={apply.isPending || selected.length === 0}
          onPress={() => apply.mutate(selected, { onSuccess: done })}
        />
      )}
      <PairAction
        label="Skip"
        secondary
        disabled={apply.isPending}
        onPress={done}
      />
    </>
  );
}
