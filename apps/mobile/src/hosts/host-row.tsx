import { formatPercent, formatRate } from "@core/format";
import type { HostRecord, HostVitals, OsKind } from "@core/generated/types";
import {
  hostStatusSummary,
  type PhoneRemoteHostStatus,
  type Tone,
} from "@core/phone-connection";
import { failureReason } from "@core/remote-errors";
import { useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { StatusWarning } from "@/connection/status-warning";
import {
  useClearOfflineHostReadings,
  useHostSparkline,
  useHostStatus,
  useHostVitals,
} from "@/data/hosts";
import { Icon, type IconName } from "@/ui/icons";
import { useMotion } from "@/ui/motion";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";
import { GapBands } from "@/widgets/gap-bands";
import { Sparkbars } from "@/widgets/sparkbars";
import { StreamArea } from "@/widgets/stream-area";

const PLATFORMS: Record<OsKind, { label: string; icon: IconName }> = {
  mac_os: { label: "macOS", icon: "apple.logo" },
  linux: { label: "Linux", icon: "server.rack" },
  unknown: { label: "Unknown OS", icon: "ellipsis" },
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function useRowOpacity(stale: boolean) {
  const { fast } = useMotion();
  const opacity = stale ? 0.5 : 1;
  return useAnimatedStyle(() => ({
    opacity: fast ? withTiming(opacity, { duration: fast }) : opacity,
  }));
}

/** Compact host card with a single VoiceOver stop for the whole row. */
export function HostRow({
  host,
  needsPairing,
  onOpen,
}: {
  host: HostRecord;
  needsPairing: boolean;
  onOpen: () => void;
}) {
  const status = useHostStatus(host.id);
  const remote = status.isError ? null : (status.data?.status ?? null);
  const connected =
    !needsPairing && (host.is_local || remote?.state === "connected");
  const pendingRemote = !host.is_local && status.isPending;
  const charts = useHostSparkline(
    host.id,
    host.info.mem_total_bytes,
    !needsPairing
  );
  const memoryKnown = host.info.mem_total_bytes > 0;
  const usingVitals = !charts.latest || !memoryKnown;
  const vitals = useHostVitals(host.id, connected && usingVitals);
  useClearOfflineHostReadings(host.id, connected);
  const stale = connected && charts.stale;
  const opacity = useRowOpacity(stale);
  const connection = rowConnection(
    host.is_local,
    remote,
    needsPairing,
    stale,
    connected && charts.paused,
    pendingRemote
  );
  const statusError =
    !needsPairing && !host.is_local && status.isError
      ? failureReason(status.error, "Pull down to reload.")
      : null;
  const platform = PLATFORMS[host.info.os];
  const readings = headlineReadings(
    connected,
    charts.latest,
    vitals.data,
    memoryKnown
  );
  const vitalsError = readError(
    vitals.error,
    "Vitals",
    connected && usingVitals
  );
  const historyError = readError(charts.error, "History", connected);
  const summaryError = readError(
    charts.summaryError,
    "Live summaries",
    connected
  );
  const {
    data: cpu,
    memory,
    network,
  } = connected ? charts : { data: null, memory: null, network: null };
  const label = [
    host.display_name,
    platform.label,
    connection.label,
    statusError,
    ...readings.map(({ label, value }) => `${label} ${value}`),
    cpu?.ariaLabel,
    memory?.ariaLabel,
    network?.ariaLabel,
    vitalsError,
    historyError,
    summaryError,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      className="min-h-[44px] gap-2 rounded-xl border border-border bg-card p-3 active:opacity-70"
      style={opacity}
    >
      <HostRowHeader
        name={host.display_name}
        icon={platform.icon}
        tone={connection.tone}
        text={connection.label}
      />
      {statusError && (
        <Text variant="caption" className="text-destructive!">
          {statusError}
        </Text>
      )}
      <Readings
        readings={readings}
        cpu={cpu}
        memory={memory}
        network={network}
      />
      {[vitalsError, historyError, summaryError]
        .filter(Boolean)
        .map((error) => (
          <Text key={error} variant="caption" className="text-destructive!">
            {error}
          </Text>
        ))}
    </AnimatedPressable>
  );
}

function Readings({
  readings,
  cpu,
  memory,
  network,
}: {
  readings: ReturnType<typeof headlineReadings>;
  cpu: ReturnType<typeof useHostSparkline>["data"];
  memory: ReturnType<typeof useHostSparkline>["memory"];
  network: ReturnType<typeof useHostSparkline>["network"];
}) {
  const colors = useThemeColors();
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline gap-2">
        {readings.map(({ label }) => (
          <Text
            key={label}
            variant="caption"
            className="min-w-0 flex-1"
            maxFontSizeMultiplier={2}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {label}
          </Text>
        ))}
      </View>
      <View className="flex-row items-baseline gap-2">
        {readings.map(({ label, value, accent }) => (
          <Text
            key={label}
            variant="cardFigure"
            className="min-w-0 flex-1"
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{ color: colors[`${accent}-ink`] }}
          >
            {value}
          </Text>
        ))}
      </View>
      {(cpu || memory || network) && (
        <View className="flex-row gap-2">
          <View className="min-w-0 flex-1">
            {cpu && <StreamArea variant="spark" {...cpu} />}
          </View>
          <View className="min-w-0 flex-1">
            {memory && <StreamArea variant="spark" {...memory} />}
          </View>
          <View className="min-w-0 flex-1">
            {network && <NetworkReading data={network} />}
          </View>
        </View>
      )}
    </View>
  );
}

function NetworkReading({
  data,
}: {
  data: NonNullable<ReturnType<typeof useHostSparkline>["network"]>;
}) {
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
      <Sparkbars data={data} height={36} accessibilityLabel={data.ariaLabel} />
      {data.bands.length > 0 && (
        <GapBands
          bands={data.bands}
          widthPx={width}
          height={36}
          fontScale={fontScale}
        />
      )}
    </View>
  );
}

function rowConnection(
  local: boolean,
  remote: PhoneRemoteHostStatus | null,
  needsPairing: boolean,
  stale: boolean,
  paused: boolean,
  pendingRemote: boolean
): { label: string; tone: Tone } {
  if (needsPairing) return { label: "Needs pairing", tone: "warning" };
  if (paused) return { label: "Paused", tone: "muted" };
  if (stale) return { label: "Stale", tone: "muted" };
  if (local) return { label: "Live", tone: "live" };
  if (pendingRemote) return { label: "Loading status…", tone: "muted" };
  return hostStatusSummary(remote, { nowMs: Date.now() });
}

function readError(error: unknown, what: string, visible: boolean) {
  return !visible || error === null
    ? null
    : `${what} unavailable. ${failureReason(error, "Pull down to reload.")}`;
}

type Readings = Pick<
  HostVitals,
  "cpu_pct" | "memory_pct" | "net_rx_bps" | "net_tx_bps"
>;

function headlineReadings(
  connected: boolean,
  latest: Readings | undefined,
  vitals: HostVitals | undefined,
  memoryKnown: boolean
) {
  const values = connected ? (latest ?? vitals) : undefined;
  const { cpu_pct, net_rx_bps, net_tx_bps } = values ?? {};
  const memoryPct =
    connected && !memoryKnown ? vitals?.memory_pct : values?.memory_pct;
  return [
    { label: "CPU", value: formatPercent(cpu_pct), accent: "cpu" },
    { label: "Memory", value: formatPercent(memoryPct), accent: "mem" },
    {
      label: "Network",
      accent: "net",
      value: formatRate(
        net_rx_bps == null || net_tx_bps == null
          ? null
          : net_rx_bps + net_tx_bps
      ),
    },
  ] as const;
}

function HostRowHeader({
  name,
  icon,
  tone,
  text,
}: {
  name: string;
  icon: IconName;
  tone: Tone;
  text: string;
}) {
  const colors = useThemeColors();
  const { fontScale } = useWindowDimensions();
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <View className="max-w-full shrink flex-row items-center gap-2">
        <Icon
          name={icon}
          size={16 * fontScale}
          color={colors["muted-foreground"]}
        />
        <Text variant="cardTitle" className="shrink">
          {name}
        </Text>
      </View>
      <View className="max-w-full flex-row items-center gap-1.5">
        {tone === "live" && <View className="size-1.5 rounded-full bg-live" />}
        {tone === "warning" && <StatusWarning />}
        <Text
          variant="caption"
          className={tone === "warning" ? "shrink text-warning-ink" : "shrink"}
        >
          {text}
        </Text>
      </View>
    </View>
  );
}
