import { commandErrorText } from "@core/command-error";
import { unwrap } from "@core/transport";
import { useEffect, useEffectEvent, useState } from "react";
import { usePhoneSettings } from "@/data/phone-settings";
import {
  type NativeTransport,
  openDebugCore,
} from "@/transport/native-transport";

type DebugCore =
  | { status: "loading" | "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; transport: NativeTransport; keyLine: string };

async function loadDebugCore(syncOnCellular: boolean): Promise<DebugCore> {
  const transport = await openDebugCore(syncOnCellular);
  if (transport === null) return { status: "missing" };
  const keyLine = await unwrap(transport.authorizedKeyLine("statglass-iphone"));
  return { status: "ready", transport, keyLine };
}

export function useDebugCore(): DebugCore {
  const [state, setState] = useState<DebugCore>({ status: "loading" });
  const syncOnCellular = usePhoneSettings(
    (settings) => settings.syncOnCellular
  );
  const load = useEffectEvent(() => loadDebugCore(syncOnCellular));

  useEffect(() => {
    let active = true;
    void load().then(
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
