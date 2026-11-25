import { historyKeys, hostKeys } from "@core/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { createDemoTransport } from "@/data/demo";
import { useSetPhoneTransport } from "@/data/transport-context";

/** Starts a fresh demo session and opens its hosts list. */
export default function DemoHosts() {
  const setTransport = useSetPhoneTransport();
  const cache = useQueryClient();
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    cache.removeQueries({ queryKey: hostKeys.all });
    cache.removeQueries({ queryKey: historyKeys.all });
    setTransport(createDemoTransport(), true);
    router.replace("/(hosts)");
  }, [cache, router, setTransport]);

  return null;
}
