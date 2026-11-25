/**
 * First-launch screen for pairing a host or trying the demo.
 */
import { Redirect } from "expo-router";
import { View } from "react-native";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { isNativeTransport, useNativeCoreStarting } from "@/transport";
import { WelcomeScreen } from "@/welcome/welcome-screen";

/** The app's opening screen before any host is paired. */
export default function FirstLaunch() {
  const transport = useOptionalPhoneTransport();
  const starting = useNativeCoreStarting();

  if (isNativeTransport(transport)) return <Redirect href="/(hosts)" />;
  if (starting) return <View className="flex-1 bg-background" />;
  return <WelcomeScreen />;
}
