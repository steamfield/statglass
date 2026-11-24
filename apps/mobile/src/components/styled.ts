/**
 * Third-party components registered with NativeWind so `className` reaches
 * them. NativeWind only rewrites `react-native`'s own components; import any
 * other component that takes classes from here.
 */
import { styled } from "nativewind";
import { SafeAreaView as NativeSafeAreaView } from "react-native-safe-area-context";

/** `SafeAreaView` that accepts `className`. */
export const SafeAreaView = styled(NativeSafeAreaView);
