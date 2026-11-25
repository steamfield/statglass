import { BlurView } from "expo-blur";
import { authenticateAsync } from "expo-local-authentication";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppState, Pressable, useColorScheme, View } from "react-native";
import { usePhoneSettings } from "@/data/phone-settings";
import { Text } from "@/ui/text";

async function authenticateToUnlock() {
  try {
    const result = await authenticateAsync({
      promptMessage: "Unlock StatGlass",
    });
    if (result.success) return "unlocked";
    return result.error === "user_cancel" ? "cancelled" : "failed";
  } catch (error) {
    console.warn("Could not authenticate to unlock StatGlass", error);
    return "failed";
  }
}

function useAppLock(enabled: boolean) {
  const lockedOnLaunch = useRef(enabled);
  const requestUnlock = useRef<(() => void) | null>(null);
  const [view, setView] = useState({
    covered: enabled,
    active: false,
    prompting: false,
  });
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) {
      lockedOnLaunch.current = false;
      setError(false);
      return;
    }

    let phase = AppState.currentState ?? "active";
    let locked = lockedOnLaunch.current || phase !== "active";
    let prompting = false;
    let promptInactive = false;
    let backgroundedDuringPrompt = false;
    let disposed = false;

    function updateView() {
      setView({
        covered: locked || phase !== "active",
        active: phase === "active",
        prompting,
      });
    }

    async function unlock() {
      if (!locked || prompting || phase !== "active") return;
      prompting = true;
      backgroundedDuringPrompt = false;
      setError(false);
      updateView();
      const result = await authenticateToUnlock();
      if (disposed) return;
      prompting = false;
      if (result === "unlocked" && !backgroundedDuringPrompt) locked = false;
      setError(result === "failed");
      updateView();
      if (backgroundedDuringPrompt) void unlock();
    }

    const listener = AppState.addEventListener("change", (next) => {
      if (phase === next) return;
      phase = next;
      switch (next) {
        case "active":
          // The iOS prompt can make the app briefly inactive on its own.
          if (!promptInactive) void unlock();
          promptInactive = false;
          break;
        case "background":
          locked = true;
          promptInactive = false;
          backgroundedDuringPrompt = prompting;
          break;
        default:
          promptInactive = prompting;
          locked ||= !prompting;
      }
      updateView();
    });
    requestUnlock.current = () => void unlock();
    updateView();
    void unlock();

    return () => {
      disposed = true;
      listener.remove();
      requestUnlock.current = null;
    };
  }, [enabled]);

  return {
    ...view,
    covered: enabled && view.covered,
    error,
    unlock: () => requestUnlock.current?.(),
  };
}

/** Blocks touch and VoiceOver access to the stack while it is covered. */
export function AppLockGate({ children }: { children: ReactNode }) {
  const enabled = usePhoneSettings((s) => s.appLock);
  const { covered, active, prompting, error, unlock } = useAppLock(enabled);
  const tint = useColorScheme() === "dark" ? "dark" : "light";

  return (
    <View className="flex-1">
      <View
        className="flex-1"
        pointerEvents={covered ? "none" : "auto"}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {covered && (
        <View
          className="absolute inset-0 justify-center px-6 pt-safe pb-safe"
          accessibilityViewIsModal
        >
          <BlurView
            tint={tint}
            intensity={100}
            style={{ position: "absolute", inset: 0 }}
          />
          <View className="absolute inset-0 bg-overlay" />
          {active && (
            <View className="gap-3 rounded-xl border border-border bg-card p-4">
              <Text role="title">StatGlass is locked</Text>
              {error && (
                <Text role="body" accessibilityRole="alert">
                  iOS couldn’t verify your identity. Try again.
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Unlock StatGlass"
                accessibilityState={{ disabled: prompting }}
                disabled={prompting}
                onPress={unlock}
                className="min-h-[44px] justify-center rounded-lg bg-primary px-4 py-2 active:opacity-70 disabled:opacity-50"
              >
                <Text
                  role="body"
                  className="font-semibold text-primary-foreground"
                >
                  Unlock
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
