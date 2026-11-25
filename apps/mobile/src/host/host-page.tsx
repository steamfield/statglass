import { formatPercent } from "@core/format";
import type { HostRecord } from "@core/generated/types";
import {
  selectBattery,
  selectCpu,
  selectGpu,
  selectMemory,
  selectNetwork,
  selectPower,
  selectPowerSource,
} from "@core/live-selectors";
import type { PopoverCard } from "@core/popover/card-order";
import { useRouter } from "expo-router";
import { memo, useEffect, useMemo, useState } from "react";
import { Animated, Easing, ScrollView, View } from "react-native";
import { shallow } from "zustand/shallow";
import { BatteryCard } from "@/cards/battery-card";
import { CpuCard } from "@/cards/cpu-card";
import { GpuCard } from "@/cards/gpu-card";
import { MemoryCard } from "@/cards/memory-card";
import { NetworkCard } from "@/cards/network-card";
import { PowerCard } from "@/cards/power-card";
import { UnavailableCard } from "@/cards/unavailable-card";
import {
  connectionStatusError,
  useHostLive,
  useRemoteStatus,
} from "@/data/live";
import { useCompactStream, useNetworkBars } from "@/data/live-stream";
import { usePhoneSettings } from "@/data/phone-settings";
import { motionEasings } from "@/theme.generated";
import { useMotion } from "@/ui/motion";
import { Text } from "@/ui/text";
import { CardMenu } from "./card-menu";
import {
  buildCardStack,
  type CardStackItem,
  cardActions,
  cardModuleStates,
} from "./card-stack";
import { ConnectionPill, useConnection } from "./connection-pill";

const CardSlot = memo(
  function CardSlot({ item }: { item: CardStackItem }) {
    switch (item.kind) {
      case "unavailable":
        return <UnavailableCard key={item.props.module} {...item.props} />;
      case "cpu":
        return <CpuCard key={item.kind} {...item.props} />;
      case "memory":
        return <MemoryCard key={item.kind} {...item.props} />;
      case "gpu":
        return <GpuCard key={item.kind} {...item.props} />;
      case "power":
        return <PowerCard key={item.kind} {...item.props} />;
      case "network":
        return <NetworkCard key={item.kind} {...item.props} />;
      case "battery":
        return <BatteryCard key={item.kind} {...item.props} />;
    }
  },
  (previous, next) =>
    previous.item.kind === next.item.kind &&
    shallow(previous.item.props, next.item.props)
);

const FADE_EASING = Easing.bezier(...motionEasings.easeOut);

function useCardOpacity(dimmed: boolean) {
  const target = dimmed ? 0.5 : 1;
  const [opacity] = useState(() => new Animated.Value(target));
  const { fast } = useMotion();
  useEffect(() => {
    if (fast === 0) {
      opacity.setValue(target);
      return;
    }
    // The design system's fast transition, driven on the native thread.
    const animation = Animated.timing(opacity, {
      toValue: target,
      duration: fast,
      easing: FADE_EASING,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [fast, opacity, target]);
  return fast === 0 ? target : opacity;
}

const CardStack = memo(function CardStack({
  host,
  dimmed,
}: {
  host: HostRecord;
  dimmed: boolean;
}) {
  const { id } = host;
  const router = useRouter();
  const [menu, setMenu] = useState<PopoverCard | null>(null);
  const compact = usePhoneSettings((state) => state.compact);
  const cardOrder = usePhoneSettings((state) => state.cardOrder);
  const opacity = useCardOpacity(dimmed);
  const caps = useHostLive(id, (state) => state.capabilities);
  const states = useMemo(() => cardModuleStates(caps), [caps]);
  const cpu = useHostLive(id, selectCpu, shallow);
  const memory = useHostLive(id, selectMemory, shallow);
  const gpu = useHostLive(id, selectGpu, shallow);
  const power = useHostLive(id, selectPower, shallow);
  const source = useHostLive(id, selectPowerSource);
  const network = useHostLive(id, selectNetwork, shallow);
  const battery = useHostLive(id, selectBattery, shallow);
  const cpuStream = useCompactStream(id, {
    accent: "cpu",
    seriesKey: "cpu.total",
    subject: "CPU",
    now: formatPercent(cpu.total),
    height: 52,
  });
  const gpuStream = useCompactStream(id, {
    accent: "gpu",
    seriesKey: "gpu.util",
    subject: "GPU",
    now: formatPercent(gpu.util),
    height: 40,
    yMax: 100,
  });
  const bars = useNetworkBars(id);
  const actions = useMemo(
    () =>
      cardActions(
        (module) =>
          router.push({
            pathname: "/(hosts)/[host]/[module]",
            params: { host: id, module },
          }),
        setMenu
      ),
    [id, router]
  );
  const cards = buildCardStack(
    states,
    { compact, cardOrder },
    {
      cpu: { cpu, stream: cpuStream },
      memory: { memory, totalBytes: host.info.mem_total_bytes },
      gpu: { gpu, stream: gpuStream },
      power: { power, source },
      network: { network, bars },
      battery: { battery, source },
    },
    actions
  );

  const order = cards.flatMap((item) =>
    item.kind === "unavailable" ? [] : [item.kind]
  );
  const index = menu === null ? -1 : order.indexOf(menu);
  const previous = order[index - 1];
  const next = order[index + 1];
  const close = () => setMenu(null);

  return (
    <>
      <Animated.View accessibilityLabel="Module cards" style={{ opacity }}>
        <View className="gap-3">
          {cards.map((item) => (
            <CardSlot
              key={item.kind === "unavailable" ? item.props.module : item.kind}
              item={item}
            />
          ))}
        </View>
      </Animated.View>
      {menu !== null && index >= 0 && (
        <CardMenu card={menu} previous={previous} next={next} onClose={close} />
      )}
    </>
  );
});

/** One pager page with a host heading, connection status and its popover cards. */
export function HostPage({
  host,
  width,
  active,
}: {
  host: HostRecord;
  width: number;
  active: boolean;
}) {
  const status = useRemoteStatus(host.id, active && !host.is_local);
  const connection = useConnection(
    host.id,
    status.data,
    !host.is_local && status.isError
      ? connectionStatusError(status.error)
      : null
  );
  const dimmed =
    connection.state === "offline" || connection.state === "reconnecting";
  return (
    <ScrollView
      style={{ width }}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 px-4 pb-5 pt-3"
    >
      <View className="gap-2">
        <Text {...{ role: "largeTitle" }}>{host.display_name}</Text>
        <ConnectionPill
          host={host.id}
          connection={connection}
          active={active}
        />
      </View>
      <CardStack host={host} dimmed={dimmed} />
    </ScrollView>
  );
}
