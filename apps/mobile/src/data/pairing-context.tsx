import { createMockPhonePairing } from "@core/mock/phone-pairing";
import { createContext, type ReactNode, useContext, useState } from "react";
import type { PhonePairing } from "./pairing-seam";

const PairingContext = createContext<PhonePairing | null>(null);

export function PairingProvider({
  children,
  pairing,
}: {
  children: ReactNode;
  pairing?: PhonePairing;
}) {
  const [mock] = useState(createMockPhonePairing);
  return (
    <PairingContext.Provider value={pairing ?? mock}>
      {children}
    </PairingContext.Provider>
  );
}

export function usePhonePairing(): PhonePairing {
  const pairing = useContext(PairingContext);
  if (pairing === null) {
    throw new Error("usePhonePairing requires PairingProvider");
  }
  return pairing;
}
