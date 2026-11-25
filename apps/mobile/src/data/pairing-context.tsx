import { createMockPhonePairing } from "@core/mock/phone-pairing";
import { failureReason } from "@core/remote-errors";
import { unwrap } from "@core/transport";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  isNativeTransport,
  type NativeTransport,
  nativePairing,
  useNativeCore,
} from "@/transport";
import type { PhonePairing } from "./pairing-seam";
import { useOptionalPhoneTransport } from "./transport-context";

type ActivePairing = ReturnType<typeof nativePairing>;
const PairingContext = createContext<ActivePairing | null>(null);

export function isDemoPairingCode(text: string): boolean {
  return __DEV__ && text.startsWith("SGPDEMO:");
}

export function PairingProvider({
  children,
  pairing,
}: {
  children: ReactNode;
  pairing?: PhonePairing;
}) {
  const { core } = useNativeCore();
  const [mock] = useState(createMockPhonePairing);
  const selected = useMemo<ActivePairing>(() => {
    if (pairing) return pairing;
    const native: ActivePairing = core ? nativePairing(core) : mock;
    return {
      previewPairing(text) {
        return (isDemoPairingCode(text) ? mock : native).previewPairing(text);
      },
      pair(text, name, model, signal?: AbortSignal) {
        if (!isDemoPairingCode(text))
          return native.pair(text, name, model, signal);
        const result = mock.pair(text, name, model);
        // Give the demo the same visible approval step as a real offer.
        setTimeout(() => mock.tick(), 1000);
        return result;
      },
    };
  }, [core, mock, pairing]);
  return (
    <PairingContext.Provider value={selected}>
      {children}
    </PairingContext.Provider>
  );
}

export function usePhonePairing(): ActivePairing {
  const pairing = useContext(PairingContext);
  if (pairing === null) {
    throw new Error("usePhonePairing requires PairingProvider");
  }
  return pairing;
}

type KeyRead = {
  native: NativeTransport;
  attempt: number;
  result: { key: string } | { error: string };
};

export function usePhonePublicKey() {
  const transport = useOptionalPhoneTransport();
  const { core } = useNativeCore();
  const native = core ?? (isNativeTransport(transport) ? transport : null);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<KeyRead | null>(null);

  useEffect(() => {
    if (!native) return;
    let active = true;
    async function readKey(core: NativeTransport) {
      try {
        const key = await unwrap(core.authorizedKeyLine("statglass-mobile"));
        if (active) setRead({ native: core, attempt, result: { key } });
      } catch (error) {
        const message = failureReason(
          error,
          "Couldn’t read this iPhone’s key."
        );
        if (active)
          setRead({ native: core, attempt, result: { error: message } });
      }
    }
    void readKey(native);
    return () => {
      active = false;
    };
  }, [native, attempt]);

  function retry() {
    setAttempt((current) => current + 1);
  }

  return {
    available: native !== null,
    result:
      read?.native === native && read.attempt === attempt ? read.result : null,
    retry,
  };
}
