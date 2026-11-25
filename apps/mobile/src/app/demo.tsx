import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { useDemo } from "@/data/demo";

/** Starts a fresh demo session and opens its hosts list. */
export default function DemoHosts() {
  const { start } = useDemo();
  const { scenario } = useLocalSearchParams<{ scenario?: string | string[] }>();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start(__DEV__ && typeof scenario === "string" ? scenario : undefined);
  }, [scenario, start]);

  return null;
}
