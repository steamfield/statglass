import { ScrollView, type ScrollViewProps } from "react-native";

export function ScreenScroll({
  headerShown: _headerShown,
  ...props
}: ScrollViewProps & { headerShown?: boolean }) {
  return <ScrollView {...props} />;
}
