import { commandErrorText } from "@core/command-error";
import { unwrap } from "@core/transport";
import { useEffect, useState } from "react";
import {
  type NativeTransport,
  useNativeCore,
  useNativeCoreStarting,
} from "@/transport";

type DebugCore =
  | { status: "loading" | "missing" | "startup-error" }
  | { status: "error"; message: string }
  | { status: "ready"; transport: NativeTransport; keyLine: string };

export function useDebugCore(): DebugCore {
  const { core, error } = useNativeCore();
  const starting = useNativeCoreStarting();
  const [key, setKey] = useState<Extract<
    DebugCore,
    { status: "ready" | "error" }
  > | null>(null);

  useEffect(() => {
    if (core === null) return;
    let active = true;
    void unwrap(core.authorizedKeyLine("statglass-iphone")).then(
      (keyLine) => {
        if (active) setKey({ status: "ready", transport: core, keyLine });
      },
      (error: unknown) => {
        if (active)
          setKey({
            status: "error",
            message: commandErrorText(
              error,
              "Couldn’t read the iPhone’s SSH key."
            ),
          });
      }
    );
    return () => {
      active = false;
    };
  }, [core]);

  if (error) return { status: "startup-error" };
  if (starting) return { status: "loading" };
  if (core === null) return { status: "missing" };
  return key ?? { status: "loading" };
}
