/**
 * The desktop's page entrance (`usePageEntrance`, D-133) for the phone: when a
 * screen's first content mounts, its cards fade in and rise into place one
 * after another, in reading order. Content that mounts within
 * `ENTRANCE_WINDOW_MS` of that (cards waiting on capabilities, a banner)
 * continues the entrance as its own staggered batch; anything later is a data
 * update and appears in place.
 * Reduce Motion and Low Power Mode zero the page token, so nothing moves.
 */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useMotion } from "./motion";

/** Last stagger step that still adds delay, so a long screen doesn't trickle in. */
export const STAGGER_CAP = 8;
/** How long after a screen's first content late content still counts as part of it. */
export const ENTRANCE_WINDOW_MS = 800;
/** Mounts closer together than this share one batch, and so one stagger run. */
const BATCH_GAP_MS = 50;
/** The rise of a card; opacity is done at 75% of the page token. */
const RISE = 8;
const OPAQUE_AT = 0.75;

export interface EntrancePlan {
  delay: number;
  duration: number;
}

/**
 * Hands out stagger positions to the units of one screen. Positions are keyed
 * by unit, so a render that runs twice (StrictMode) claims one slot.
 */
export class EntranceScope {
  /** The window opens with the first claim, so content behind a query still enters. */
  private openedAt: number | null = null;
  private batchAt = -Infinity;
  private next = 0;
  private readonly claimed = new Map<string, number | null>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** The unit's stagger index, or null once the entrance window has closed. */
  claim(unit: string): number | null {
    const known = this.claimed.get(unit);
    if (known !== undefined) return known;
    const at = this.now();
    this.openedAt ??= at;
    // Past the window nothing enters, and nothing is kept: a long-lived list
    // remounts rows as it scrolls.
    if (at - this.openedAt > ENTRANCE_WINDOW_MS) return null;
    if (at - this.batchAt > BATCH_GAP_MS) this.next = 0;
    this.batchAt = at;
    const index = this.next++;
    this.claimed.set(unit, index);
    return index;
  }
}

/** Delay and length of a unit's entrance, or null when it should not move. */
export function entrancePlan(
  index: number | null,
  { page, stagger }: { page: number; stagger: number }
): EntrancePlan | null {
  if (index === null || page <= 0) return null;
  return { delay: Math.min(index, STAGGER_CAP) * stagger, duration: page };
}

const ScopeContext = createContext<EntranceScope | null>(null);

/** Opens an entrance for a screen; remount it (a new `key`) to replay. */
export function EntranceProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(() => new EntranceScope());
  return (
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  );
}

/**
 * One entering unit: a card or block. Outside an `EntranceProvider` it renders
 * its children as they are.
 */
export function Entrance({ children }: { children: ReactNode }) {
  const scope = useContext(ScopeContext);
  const motion = useMotion();
  const unit = useId();
  const [plan] = useState(() =>
    entrancePlan(scope?.claim(unit) ?? null, motion)
  );
  const progress = useSharedValue(plan ? 0 : 1);
  const { easeEnter } = motion;
  useEffect(() => {
    if (!plan) return;
    progress.set(
      withDelay(
        plan.delay,
        withTiming(1, {
          duration: plan.duration,
          easing: Easing.bezier(...easeEnter),
          // The motion context already reads Reduce Motion (page is 0 then).
          reduceMotion: ReduceMotion.Never,
        })
      )
    );
  }, [plan, easeEnter, progress]);
  const entering = useAnimatedStyle(() => {
    const p = progress.get();
    return {
      opacity: Math.min(1, p / OPAQUE_AT),
      transform: [{ translateY: RISE * (1 - p) }],
    };
  });
  return <Animated.View style={entering}>{children}</Animated.View>;
}
