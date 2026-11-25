import {
  type ErrorBoundaryProps,
  useGlobalSearchParams,
  usePathname,
} from "expo-router";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { RetryPanel } from "./retry-panel";

export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const pathname = usePathname();
  const { host, module, scenario } = useGlobalSearchParams();
  const logged = useRef<Error | null>(null);
  useEffect(() => {
    if (logged.current === error) return;
    logged.current = error;
    console.error("[navigation] screen failed", {
      pathname,
      host,
      module,
      scenario,
      error,
    });
  }, [error, host, module, pathname, scenario]);

  return (
    <View className="flex-1 justify-center bg-background px-6 pt-safe pb-safe">
      <RetryPanel
        title="This screen couldn’t load"
        retry={() => void retry()}
      />
    </View>
  );
}
