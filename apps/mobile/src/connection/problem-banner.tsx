import type { HostId } from "@core/generated/types";
import type { PhoneAction, PhoneProblem } from "@core/phone-connection";
import { hostKeys } from "@core/query-keys";
import { failureReason } from "@core/remote-errors";
import { unwrap } from "@core/transport";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { usePhoneTransport } from "@/data/transport-context";
import { Text } from "@/ui/text";
import { StatusWarning } from "./status-warning";
import { useStatusAnnouncement } from "./use-status-announcement";

const actionLabel: Record<PhoneAction, string> = {
  re_pair: "Re-pair",
  retry: "Retry",
  open_settings: "Open Settings",
  open_tailscale: "Open Tailscale",
};

export function ProblemBanner({
  host,
  problem,
}: {
  host: HostId;
  problem: PhoneProblem;
}) {
  const router = useRouter();
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const [running, setRunning] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  useStatusAnnouncement(actionFailure);
  const actions = [problem.action, problem.alternateAction].filter(
    (action) => action != null
  );

  async function actOnProblem(action: PhoneAction) {
    if (running) return;
    setRunning(true);
    setActionFailure(null);
    try {
      switch (action) {
        case "re_pair":
          router.push("/pair");
          break;
        case "retry":
          await unwrap(transport.retryRemoteHost(host));
          await cache.invalidateQueries({ queryKey: hostKeys.remote() });
          break;
        case "open_settings":
          await Linking.openSettings();
          break;
        case "open_tailscale":
          await Linking.openURL("tailscale://");
          break;
      }
    } catch (error) {
      console.warn(`Could not complete connection action: ${action}`, error);
      switch (action) {
        case "open_tailscale":
          setActionFailure(
            "Open Tailscale from the Home Screen, or install it from the App Store."
          );
          break;
        case "open_settings":
          setActionFailure(
            "Open Settings from the Home Screen and choose StatGlass."
          );
          break;
        default:
          setActionFailure(failureReason(error, "Please try again."));
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <View className="gap-1.5 rounded-xl border border-border bg-card p-3">
      <View className="flex-row items-center gap-1.5">
        {problem.tone === "warning" && <StatusWarning />}
        <Text
          variant="cardTitle"
          className={
            problem.tone === "warning" ? "shrink text-warning-ink" : "shrink"
          }
        >
          {problem.title}
        </Text>
      </View>
      <Text variant="body">{problem.recovery}</Text>
      {actions.map((action) => (
        <Pressable
          key={action}
          accessibilityRole="button"
          className="min-h-[44px] justify-center self-start rounded-lg bg-primary px-3 active:opacity-70 disabled:opacity-50"
          disabled={running}
          onPress={() => void actOnProblem(action)}
        >
          <Text
            variant="body"
            className="font-semibold! text-primary-foreground"
          >
            {actionLabel[action]}
          </Text>
        </Pressable>
      ))}
      {actionFailure && (
        <Text
          variant="caption"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="text-destructive!"
        >
          {actionFailure}
        </Text>
      )}
    </View>
  );
}
