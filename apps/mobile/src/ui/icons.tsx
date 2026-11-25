import { Text } from "./text";

export type IconName =
  | "chevron.left"
  | "chevron.right"
  | "chevron.down"
  | "chevron.up"
  | "gearshape"
  | "xmark"
  | "ellipsis"
  | "checkmark"
  | "line.3.horizontal"
  | "apple.logo"
  | "server.rack"
  | "doc.on.doc";

export function Icon(props: {
  name: IconName;
  size?: number;
  color?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Text variant="caption">{props.accessibilityLabel ?? props.name}</Text>
  );
}
