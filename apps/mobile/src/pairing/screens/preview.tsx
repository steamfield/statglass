import type { PairingPreview } from "@core/generated/types";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Icon, type IconName } from "@/ui/icons";
import { Text } from "@/ui/text";
import { PairingStep } from "./pairing-step";

const GLYPHS = new Map<string, IconName>([["macos", "apple.logo"]]);

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
  const platform = offer.os.toLowerCase().split(" ")[0] ?? "";
  const glyph = GLYPHS.get(platform) ?? "server.rack";
  return (
    <PairingStep
      title="Check the host"
      explanation="Confirm this is the host you want to add."
      actions={
        <>
          <Button label="Confirm" onPress={confirm} />
          <Button label="Cancel" variant="secondary" onPress={cancel} />
        </>
      }
    >
      <Card padding="lg" className="gap-2">
        <View className="flex-row items-center gap-2">
          <Icon name={glyph} size={20} />
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
          <Text variant="body">Can also add the hosts it monitors</Text>
        )}
        <Text variant="cardFigure">{offer.code}</Text>
        <Countdown expires={offer.expires_ms} />
      </Card>
    </PairingStep>
  );
}
