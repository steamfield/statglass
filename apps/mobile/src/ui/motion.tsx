import {
  addLowPowerModeListener,
  isLowPowerModeEnabledAsync,
} from "expo-battery";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { AccessibilityInfo } from "react-native";
import { motionDurations, motionEasings } from "@/theme.generated";

type Durations = Record<keyof typeof motionDurations, number>;
type Motion = Readonly<Durations> &
  typeof motionEasings & { readonly reduced: boolean };

const zeroDurations = Object.fromEntries(
  Object.keys(motionDurations).map((key) => [key, 0])
) as Durations;
const still: Motion = { ...zeroDurations, ...motionEasings, reduced: true };
const animated: Motion = {
  ...motionDurations,
  ...motionEasings,
  reduced: false,
};
const MotionContext = createContext<Motion | null>(null);

function watchPreference(
  name: string,
  read: () => Promise<boolean>,
  listen: (update: (enabled: boolean) => void) => { remove(): void },
  update: (enabled: boolean) => void
) {
  let active = true;
  let sawEvent = false;
  const subscription = listen((enabled) => {
    if (!active) return;
    sawEvent = true;
    update(enabled);
  });
  void read().then(
    (enabled) => {
      if (active && !sawEvent) update(enabled);
    },
    (error: unknown) => {
      if (active) console.warn(`Could not read ${name}`, error);
    }
  );
  return () => {
    active = false;
    subscription.remove();
  };
}

/** Supplies motion tokens once both system preferences allow animation. */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let reduceMotion = true;
    let lowPowerMode = true;
    const stopReduceMotion = watchPreference(
      "Reduce Motion",
      () => AccessibilityInfo.isReduceMotionEnabled(),
      (update) =>
        AccessibilityInfo.addEventListener("reduceMotionChanged", update),
      (enabled) => {
        reduceMotion = enabled;
        setReduced(reduceMotion || lowPowerMode);
      }
    );
    const stopLowPowerMode = watchPreference(
      "Low Power Mode",
      isLowPowerModeEnabledAsync,
      (update) =>
        addLowPowerModeListener(({ lowPowerMode }) => update(lowPowerMode)),
      (enabled) => {
        lowPowerMode = enabled;
        setReduced(reduceMotion || lowPowerMode);
      }
    );
    return () => {
      stopReduceMotion();
      stopLowPowerMode();
    };
  }, []);
  return (
    <MotionContext.Provider value={reduced ? still : animated}>
      {children}
    </MotionContext.Provider>
  );
}

/** Reads shared motion tokens. @throws {Error} outside MotionProvider */
export function useMotion(): Motion {
  const motion = useContext(MotionContext);
  if (motion === null) {
    throw new Error(
      "useMotion was called outside MotionProvider; mount it in the root layout or the test's render helper."
    );
  }
  return motion;
}
