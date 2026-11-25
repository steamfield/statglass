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

const SPARKBARS_HEIGHT = 36;

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
  const readings = rowReadings(
    connected,
    pendingRemote || firstDial(remote, needsPairing),
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
  readings: ReturnType<typeof rowReadings>;
  cpu: ReturnType<typeof useHostSparkline>["data"];
  memory: ReturnType<typeof useHostSparkline>["memory"];
  network: ReturnType<typeof useHostSparkline>["network"];
}) {
  const colors = useThemeColors();
  const { fontScale } = useWindowDimensions();
  if (readings.length === 0) return null;
  // Three figures across the top, then each chart at the card's full width.
  // At accessibility sizes the figures stack so none has to shrink.
  const stacked = fontScale >= 1.35;
  return (
    <View className="gap-3">
      <View className={stacked ? "gap-2" : "flex-row gap-3"}>
        {readings.map(({ label, value, accent }) => (
          <View key={label} className={stacked ? "" : "min-w-0 flex-1"}>
            <Text variant="caption" numberOfLines={1}>
              {label}
            </Text>
            <Text
              variant="cardFigure"
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{ color: colors[`${accent}-ink`] }}
            >
              {value}
            </Text>
          </View>
        ))}
      </View>
      {(cpu || memory || network) && (
        <View className="gap-2">
          {cpu && <StreamArea variant="spark" {...cpu} />}
          {memory && <StreamArea variant="spark" {...memory} />}
          {network && <NetworkReading data={network} />}
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
    <View className="flex-row gap-1">
      {/* Each half's ceiling, as the area charts label theirs. */}
      <View className="justify-between" style={{ height: SPARKBARS_HEIGHT }}>
        <Text variant="axis">↑ {formatRate(data.upMax)}</Text>
        <Text variant="axis">↓ {formatRate(data.downMax)}</Text>
      </View>
      <View
        className="min-w-0 flex-1"
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      >
        <Sparkbars
          data={data}
          height={SPARKBARS_HEIGHT}
          accessibilityLabel={data.ariaLabel}
        />
        {data.bands.length > 0 && (
          <GapBands
            bands={data.bands}
            widthPx={width}
            height={SPARKBARS_HEIGHT}
            fontScale={fontScale}
          />
        )}
      </View>
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

/**
 * A host with nothing to read (disabled, offline, needs pairing or attention)
 * collapses to its status line; while its status loads or it first connects
 * the readings stay, so the row doesn't jump.
 */
function rowReadings(
  connected: boolean,
  settling: boolean,
  latest: Readings | undefined,
  vitals: HostVitals | undefined,
  memoryKnown: boolean
) {
  if (!connected && !settling) return [];
  return headlineReadings(connected, latest, vitals, memoryKnown);
}

/** A first dial keeps the dashes so the row doesn't shrink and regrow on launch. */
function firstDial(
  remote: PhoneRemoteHostStatus | null,
  needsPairing: boolean
) {
  return (
    !needsPairing &&
    remote?.state === "connecting" &&
    remote.failure_kind === null
  );
}

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
