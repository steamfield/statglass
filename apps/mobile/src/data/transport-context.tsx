/**
 * Which `PhoneTransport` the app reads through, and whether it is the demo.
 * Nothing is chosen at launch; the demo entry or (later) pairing sets one,
 * and every data hook reads it from here so the swap happens in one place.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";
import type { PhoneTransport } from "./seam";

/** The chosen transport, null until one is set. */
interface TransportChoice {
  transport: PhoneTransport | null;
  demo: boolean;
}

type SetTransport = (transport: PhoneTransport | null, demo: boolean) => void;

const NOTHING_CHOSEN: TransportChoice = { transport: null, demo: false };

const ChoiceContext = createContext<TransportChoice | null>(null);
const SetContext = createContext<SetTransport | null>(null);

/** Props for {@link PhoneTransportProvider}. */
export interface PhoneTransportProviderProps {
  children: ReactNode;
  /** A transport chosen from the start, as tests and previews use. */
  initial?: { transport: PhoneTransport; demo: boolean };
}

/** Holds the app's transport choice for everything below it. */
export function PhoneTransportProvider({
  children,
  initial,
}: PhoneTransportProviderProps) {
  const [choice, setChoice] = useState<TransportChoice>(
    initial ?? NOTHING_CHOSEN
  );
  const set = useCallback<SetTransport>(
    (transport, demo) => setChoice({ transport, demo }),
    []
  );
  return (
    <SetContext.Provider value={set}>
      <ChoiceContext.Provider value={choice}>{children}</ChoiceContext.Provider>
    </SetContext.Provider>
  );
}

function useChoice(hook: string): TransportChoice {
  const choice = useContext(ChoiceContext);
  if (choice === null) {
    throw new Error(
      `${hook} was called outside PhoneTransportProvider; mount it in the root layout (Providers) or the test's render helper.`
    );
  }
  return choice;
}

/**
 * The chosen transport.
 * @throws {Error} outside the provider, or before the demo or pairing chose one
 */
export function usePhoneTransport(): PhoneTransport {
  const { transport } = useChoice("usePhoneTransport");
  if (transport === null) {
    throw new Error(
      "usePhoneTransport: no transport is chosen yet. Open the demo hosts or pair a host before rendering a data screen."
    );
  }
  return transport;
}

/** Lets a route redirect before mounting data hooks if no transport is chosen. */
export function useOptionalPhoneTransport(): PhoneTransport | null {
  return useChoice("useOptionalPhoneTransport").transport;
}

/**
 * Chooses the transport (null clears it) and says whether it is the demo.
 * @throws {Error} outside the provider
 */
export function useSetPhoneTransport(): SetTransport {
  const set = useContext(SetContext);
  if (set === null) {
    throw new Error(
      "useSetPhoneTransport was called outside PhoneTransportProvider; mount it in the root layout (Providers) or the test's render helper."
    );
  }
  return set;
}

/** Whether the chosen transport is the demo hosts. */
export function useIsDemo(): boolean {
  return useChoice("useIsDemo").demo;
}
