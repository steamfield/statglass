/**
 * The phone's own settings: host order, names and removals, card density
 * and order, appearance, cellular use and the app lock.
 */
import type { HostId } from "@core/generated/types";
import type { PopoverCard } from "@core/popover/card-order";
import { File, Paths } from "expo-file-system";
import { writeAsStringAsync } from "expo-file-system/legacy";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Appearance } from "react-native";
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
  set(
    patch:
      | Partial<PhoneSettings>
      | ((settings: PhoneSettings) => Partial<PhoneSettings>)
  ): void;
}

type PhoneSettingsStore = StoreApi<PhoneSettings>;

/** A new settings store starting from the defaults plus `initial`. */
export function createPhoneSettingsStore(
  initial: Partial<PhoneSettings> = {}
): PhoneSettingsStore {
  return createStore<PhoneSettings>()(() => ({
    ...DEFAULT_PHONE_SETTINGS,
    ...initial,
  }));
}

const StoreContext = createContext<PhoneSettingsStore | null>(null);

export interface PhoneSettingsStorage {
  read(): string | null | Promise<string | null>;
  write(text: string): void | Promise<void>;
}

const DOCUMENT_STORAGE: PhoneSettingsStorage = {
  read() {
    const file = new File(Paths.document, "phone-settings.json");
    return file.exists ? file.text() : null;
  },
  write(text) {
    // The Expo iOS string writer in the legacy API atomically replaces the file.
    return writeAsStringAsync(
      new File(Paths.document, "phone-settings.json").uri,
      text
    );
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function readSettings(text: string): PhoneSettings {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("Expected a settings object");
  const settings = { ...DEFAULT_PHONE_SETTINGS, ...parsed };
  if (
    !isStringArray(settings.hostOrder) ||
    !isStringArray(settings.removed) ||
    !isRecord(settings.hostNames) ||
    !Object.values(settings.hostNames).every(
      (name) => typeof name === "string"
    ) ||
    !isRecord(settings.compact) ||
    !Object.keys(DEFAULT_PHONE_SETTINGS.compact).every(
      (card) => typeof settings.compact[card as PopoverCard] === "boolean"
    ) ||
    (settings.cardOrder !== null &&
      (!isStringArray(settings.cardOrder) ||
        !settings.cardOrder.every((card) =>
          Object.hasOwn(DEFAULT_PHONE_SETTINGS.compact, card)
        ))) ||
    !["system", "light", "dark"].includes(settings.appearance) ||
    typeof settings.liveOnCellular !== "boolean" ||
    typeof settings.appLock !== "boolean"
  ) {
    throw new Error("Invalid phone settings");
  }
  return settings;
}

let warnedWrite = false;

function persistChanges(
  store: PhoneSettingsStore,
  storage: PhoneSettingsStorage
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();

  function flush() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    const text = JSON.stringify(store.getState());
    pending = pending
      .then(() => storage.write(text))
      .catch((error: unknown) => {
        if (warnedWrite) return;
        warnedWrite = true;
        console.warn("[phone settings] Could not save settings", error);
      });
  }

  const stop = store.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  });
  return () => {
    stop();
    flush();
  };
}

function AppearanceBridge(): null {
  const appearance = usePhoneSettings((settings) => settings.appearance);
  useEffect(() => {
    Appearance.setColorScheme(appearance === "system" ? "auto" : appearance);
  }, [appearance]);
  return null;
}

/** Props for {@link PhoneSettingsProvider}. */
export interface PhoneSettingsProviderProps {
  children: ReactNode;
  /** Settings to start from instead of the defaults, as tests use. */
  initial?: Partial<PhoneSettings>;
  /** Storage for this mount. Tests may supply an in-memory adapter. */
  storage?: PhoneSettingsStorage;
}

/** Owns one settings store for everything below it. */
export function PhoneSettingsProvider({
  children,
  initial,
  // Tests opt into persistence by supplying their own adapter.
  storage = initial === undefined && process.env.NODE_ENV !== "test"
    ? DOCUMENT_STORAGE
    : undefined,
}: PhoneSettingsProviderProps) {
  const [store] = useState(() => createPhoneSettingsStore(initial));
  const [ready, setReady] = useState(storage === undefined);
  const read = useRef<Promise<PhoneSettings | null> | null>(null);

  useEffect(() => {
    if (!storage) return;
    let active = true;
    let stop: (() => void) | undefined;
    read.current ??= Promise.resolve()
      .then(() => storage.read())
      .then((text) => (text === null ? null : readSettings(text)))
      .catch((error: unknown) => {
        console.warn("[phone settings] Could not read settings", error);
        return null;
      });
    void read.current.then((settings) => {
      if (!active) return;
      if (settings) store.setState(settings);
      stop = persistChanges(store, storage);
      setReady(true);
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [storage, store]);

  if (!ready) return null;
  return (
    <StoreContext.Provider value={store}>
      <AppearanceBridge />
      {children}
    </StoreContext.Provider>
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
  return useMemo<PhoneSettingsActions>(
    () => ({ set: (patch) => store.setState(patch) }),
    [store]
  );
}
