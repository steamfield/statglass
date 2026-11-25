import { Redirect } from "expo-router";
import { DebugScreen } from "@/debug/debug-screen";

export default function DebugRoute() {
  return __DEV__ ? <DebugScreen /> : <Redirect href="/" />;
}
