import type { PairedHost } from "@core/generated/types";
import type { useRouter } from "expo-router";

export function afterPair(
  router: Pick<ReturnType<typeof useRouter>, "replace">,
  _result: PairedHost
) {
  router.replace("/(hosts)");
}
