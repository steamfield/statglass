import { commandErrorText } from "@core/command-error";
import { unwrap } from "@core/transport";
import { useEffect, useState } from "react";
import {
  type NativeTransport,
  openDebugCore,
} from "@/transport/native-transport";

type DebugCore =
  | { status: "loading" | "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; transport: NativeTransport; keyLine: string };

async function loadDebugCore(): Promise<DebugCore> {
  const transport = await openDebugCore();
  if (transport === null) return { status: "missing" };
  const keyLine = await unwrap(transport.authorizedKeyLine("statglass-iphone"));
  return { status: "ready", transport, keyLine };
}

export function useDebugCore(): DebugCore {
  const [state, setState] = useState<DebugCore>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void loadDebugCore().then(
      (core) => {
        if (active) setState(core);
      },
      (error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message: commandErrorText(
              error,
              "Couldn’t prepare the native core."
            ),
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, []);

  return state;
}
