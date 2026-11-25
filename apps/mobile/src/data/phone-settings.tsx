/**
 * The phone's own settings: host order, names and removals, card density
 * and order, appearance, cellular use and the app lock. One `zustand/vanilla`
 * store per provider mount, held in memory this phase; persistence arrives
 * with pairing.
 */
import type { HostId } from "@core/generated/types";
import type { PopoverCard } from "@core/popover/card-order";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

/** Everything the phone remembers about how to show hosts. */
export interface PhoneSettings {
  /** Hosts in the user's order; hosts not listed follow in list order. */
  hostOrder: HostId[];
  /** Names given on the phone; they win over the host's own name. */
  hostNames: Record<HostId, string>;
  /** Hosts removed from the phone's list. */
  removed: HostId[];
  /** Cards shown in compact density (header and headline only). */
  compact: Record<PopoverCard, boolean>;
  /** The user's card order; null keeps the popover's module order. */
  cardOrder: PopoverCard[] | null;
  appearance: "system" | "light" | "dark";
  liveOnCellular: boolean;
  appLock: boolean;
}

/** What a fresh install starts with. */
export const DEFAULT_PHONE_SETTINGS: PhoneSettings = {
  hostOrder: [],
  hostNames: {},
  removed: [],
  compact: {
    cpu: false,
    memory: false,
    gpu: false,
    power: false,
    network: false,
    battery: false,
  },
  cardOrder: null,
  appearance: "system",
  liveOnCellular: true,
  appLock: false,
};

/** Writes to the settings. */
export interface PhoneSettingsActions {
  set(patch: Partial<PhoneSettings>): void;
}

type PhoneSettingsStore = StoreApi<PhoneSettings>;

/** A new settings store starting from the defaults plus `initial`. */
export function createPhoneSettingsStore(
  initial: Partial<PhoneSettings> = {}
): PhoneSettingsStore {
  const recognised = Object.fromEntries(
    Object.entries(initial).filter(([key]) =>
      Object.hasOwn(DEFAULT_PHONE_SETTINGS, key)
    )
  );
  return createStore<PhoneSettings>()(() => ({
    ...DEFAULT_PHONE_SETTINGS,
    ...recognised,
  }));
}

const StoreContext = createContext<PhoneSettingsStore | null>(null);

/** Props for {@link PhoneSettingsProvider}. */
export interface PhoneSettingsProviderProps {
  children: ReactNode;
  /** Settings to start from instead of the defaults, as tests use. */
  initial?: Partial<PhoneSettings>;
}

/** Owns one settings store for everything below it. */
export function PhoneSettingsProvider({
  children,
  initial,
}: PhoneSettingsProviderProps) {
  const [store] = useState(() => createPhoneSettingsStore(initial));
  return (
    <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
  );
}

function useSettingsStore(hook: string): PhoneSettingsStore {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error(
      `${hook} was called outside PhoneSettingsProvider; mount it in the root layout (Providers) or the test's render helper.`
    );
  }
  return store;
}

/**
 * A slice of the settings; re-renders when the slice changes. Return a
 * stable value (a field, not a fresh object) or the caller re-renders on
 * every write.
 * @throws {Error} outside the provider
 */
export function usePhoneSettings<T>(select: (s: PhoneSettings) => T): T {
  return useStore(useSettingsStore("usePhoneSettings"), select);
}

/**
 * The settings writes.
 * @throws {Error} outside the provider
 */
export function usePhoneSettingsActions(): PhoneSettingsActions {
  const store = useSettingsStore("usePhoneSettingsActions");
  return useMemo(
    () => ({ set: (patch: Partial<PhoneSettings>) => store.setState(patch) }),
    [store]
  );
}
