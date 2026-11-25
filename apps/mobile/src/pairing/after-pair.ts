import type { HostId, PairedHost } from "@core/generated/types";
import type { useRouter } from "expo-router";

let currentOffer: PairedHost | undefined;

export function pairOffer(host: HostId | undefined) {
  return currentOffer?.id === host ? currentOffer : undefined;
}

export function clearPairOffer(host: HostId) {
  if (currentOffer?.id === host) currentOffer = undefined;
}

export function afterPair(
  router: Pick<ReturnType<typeof useRouter>, "replace">,
  result: PairedHost
) {
  // The core only returns these lists for an offer that had can_hand_over.
  if (result.offered?.length || result.unavailable?.length) {
    currentOffer = result;
    router.replace({ pathname: "/pair-hosts", params: { host: result.id } });
  } else {
    currentOffer = undefined;
    router.replace("/(hosts)");
  }
}
