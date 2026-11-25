import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { createDemoTransport } from "@/data/demo";
import { useSetPhoneTransport } from "@/data/transport-context";

/** Starts a fresh demo session and opens its hosts list. */
export default function DemoHosts() {
  const setTransport = useSetPhoneTransport();
  const { scenario } = useLocalSearchParams<{ scenario?: string | string[] }>();
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setTransport(
      createDemoTransport(typeof scenario === "string" ? scenario : undefined),
      true
    );
    router.replace("/(hosts)");
  }, [router, scenario, setTransport]);

  return null;
}
