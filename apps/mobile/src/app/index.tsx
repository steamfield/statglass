/**
 * First-launch screen for pairing a host or trying the demo.
 */
import { Redirect } from "expo-router";
import { View } from "react-native";
import { useHosts } from "@/data/hosts-list";
import { useOptionalPhoneTransport } from "@/data/transport-context";
import { isNativeTransport, useNativeCoreStarting } from "@/transport";
import { WelcomeScreen } from "@/welcome/welcome-screen";

/** The app's opening screen before any host is paired. */
export default function FirstLaunch() {
  const transport = useOptionalPhoneTransport();
  const starting = useNativeCoreStarting();

  if (starting) return <View className="flex-1 bg-background" />;
  if (isNativeTransport(transport)) return <NativeEntry />;
  return <WelcomeScreen />;
}

function NativeEntry() {
  const hosts = useHosts();
  if (hosts.isPending) return <View className="flex-1 bg-background" />;
  if (hosts.data?.length === 0) return <WelcomeScreen />;
  // The hosts screen already provides retry when the roster couldn't load.
  return <Redirect href="/(hosts)" />;
}
