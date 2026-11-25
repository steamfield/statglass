import { useLocalSearchParams, useRouter } from "expo-router";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { PairSelection } from "@/handover/pair-selection";
import { clearPairOffer, pairOffer } from "@/pairing/after-pair";
import { PairAction } from "@/pairing/screens/action";
import { isNativeTransport } from "@/transport";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";

export default function PairHosts() {
  const { host } = useLocalSearchParams<{ host?: string }>();
  const router = useRouter();
  const core = useOptionalPhoneTransport();
  const offer = pairOffer(host);
  function done() {
    if (offer) clearPairOffer(offer.id);
    router.replace("/(hosts)");
  }
  return (
    <ScreenScroll
      className="flex-1"
      contentContainerClassName="gap-4 px-6 pt-4 pb-safe-or-6"
    >
      {offer && isNativeTransport(core) ? (
        <PairSelection core={core} offer={offer} done={done} />
      ) : (
        <>
          <Text variant="body">No host offer to review.</Text>
          <PairAction label="Go to Hosts" onPress={done} />
        </>
      )}
    </ScreenScroll>
  );
}
