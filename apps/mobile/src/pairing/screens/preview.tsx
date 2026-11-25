import type { PairingPreview } from "@core/generated/types";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";
import { PairAction } from "./action";

const GLYPHS = new Map([
  ["macos", "M3 3h14v10H3z M7 17h6m-3-4v4"],
  ["linux", "M3 4h14v12H3z M6 7l3 3-3 3m5 0h3"],
]);

function Countdown({ expires }: { expires: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= expires) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expires]);
  const seconds = Math.max(0, Math.ceil((expires - now) / 1000));
  return (
    <Text variant="label">
      {seconds === 0 ? "Code expired" : `Expires in ${seconds}s`}
    </Text>
  );
}

export function Preview({
  offer,
  confirm,
  cancel,
}: {
  offer: PairingPreview;
  confirm(): void;
  cancel(): void;
}) {
  const colors = useThemeColors();
  const platform = offer.os.toLowerCase().split(" ")[0] ?? "";
  const glyph = GLYPHS.get(platform) ?? "M3 4h14v12H3z";
  return (
    <>
      <View className="gap-2 rounded-xl border border-border bg-card p-4">
        <View className="flex-row items-center gap-2">
          <Svg width={20} height={20} viewBox="0 0 20 20" accessible={false}>
            <Path
              d={glyph}
              fill="none"
              stroke={colors.foreground}
              strokeWidth={1.5}
            />
          </Svg>
          <Text variant="title" className="shrink">
            {offer.name}
          </Text>
        </View>
        <Text variant="label">{offer.os}</Text>
        <Text variant="body">User {offer.user}</Text>
        {offer.targets.map(({ route, host }) => (
          <Text key={`${route}:${host}`} variant="body">
            {route === "lan" ? "LAN" : "Tailscale"} · {host}
          </Text>
        ))}
        {offer.can_hand_over && (
          <Text variant="body">
            This host can also add the hosts it monitors.
          </Text>
        )}
        <Text variant="cardFigure">{offer.code}</Text>
        <Countdown expires={offer.expires_ms} />
      </View>
      <PairAction label="Confirm" onPress={confirm} />
      <PairAction label="Cancel" secondary onPress={cancel} />
    </>
  );
}
