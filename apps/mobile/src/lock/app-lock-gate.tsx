import { BlurView } from "expo-blur";
import { authenticateAsync } from "expo-local-authentication";
import { type ReactNode, useEffect, useReducer, useRef } from "react";
import { AppState, Pressable, useColorScheme, View } from "react-native";
import { usePhoneSettings } from "@/data/phone-settings";
import { Text } from "@/ui/text";
import {
  initialLockState,
  isLockCovered,
  nextLockState,
  type UnlockResult,
} from "./lock-state";

async function authenticateToUnlock(): Promise<UnlockResult> {
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
  const [state, dispatch] = useReducer(nextLockState, enabled, (value) =>
    initialLockState(value, AppState.currentState ?? "active")
  );
  const authenticating = useRef(false);

  useEffect(() => {
    const listener = AppState.addEventListener("change", (phase) =>
      dispatch({ type: "app-state", phase })
    );
    dispatch({ type: "app-state", phase: AppState.currentState ?? "active" });
    return () => listener.remove();
  }, []);

  useEffect(() => {
    dispatch({ type: "enabled", enabled });
  }, [enabled]);

  useEffect(() => {
    const { prompt } = state;
    if (!enabled || prompt !== "queued" || authenticating.current) return;
    authenticating.current = true;
    dispatch({ type: "prompt-started" });
    void authenticateToUnlock().then((result) => {
      authenticating.current = false;
      dispatch({ type: "prompt-resolved", result });
    });
  }, [enabled, state]);

  return {
    covered: enabled && isLockCovered(state),
    active: state.phase === "active",
    prompting: state.prompt !== "idle",
    error: state.error,
    unlock: () => dispatch({ type: "request-unlock" }),
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
