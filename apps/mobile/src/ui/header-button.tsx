import { Icon, type IconName } from "./icons";

export function HeaderButton(props: {
  icon: IconName;
  accessibilityLabel: string;
  onPress(): void;
}) {
  return (
    <Icon name={props.icon} accessibilityLabel={props.accessibilityLabel} />
  );
}
