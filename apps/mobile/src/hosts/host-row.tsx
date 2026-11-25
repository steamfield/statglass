import { formatPercent, formatRate } from "@core/format";
import type { HostRecord, HostVitals, OsKind } from "@core/generated/types";
import { hostStatusSummary, type Tone } from "@core/phone-connection";
import { failureReason } from "@core/remote-errors";
import { Pressable, useColorScheme, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { StatusWarning } from "@/connection/status-warning";
import {
  useClearOfflineHostReadings,
  useHostSparkline,
  useHostStatus,
  useHostVitals,
} from "@/data/hosts";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";
import { StreamArea } from "@/widgets/stream-area";

const PLATFORMS: Record<OsKind, { label: string; path: string }> = {
  mac_os: { label: "macOS", path: "M3 3h14v10H3z M7 17h6m-3-4v4" },
  linux: { label: "Linux", path: "M3 4h14v12H3z M6 7l3 3-3 3m5 0h3" },
  unknown: {
    label: "Unknown OS",
    path: "M3 4h14v12H3z M9 8a1.5 1.5 0 1 1 2 1.4l-1 1.1m0 2.5v.1",
  },
};

/** Compact host card with a single VoiceOver stop for the whole row. */
export function HostRow({
  host,
  onOpen,
}: {
  host: HostRecord;
  onOpen: () => void;
}) {
  const status = useHostStatus(host.id);
  const remote = status.isError ? null : (status.data?.status ?? null);
  const connected = host.is_local || remote?.state === "connected";
  const vitals = useHostVitals(host.id, connected);
  const pendingRemote = !host.is_local && status.isPending;
  const sparkline = useHostSparkline(host.id);
  useClearOfflineHostReadings(host.id, connected);
  const connection = host.is_local
    ? { label: "Live", tone: "live" as const }
    : hostStatusSummary(remote, { nowMs: Date.now() });
  const statusText = pendingRemote ? "Loading status…" : connection.label;
  const statusError =
    !host.is_local && status.isError
      ? failureReason(status.error, "Pull down to reload.")
      : null;
  const platform = PLATFORMS[host.info.os];
  const readings = headlineReadings(connected ? vitals.data : undefined);
  const chart = connected ? sparkline.data : null;
  const vitalsError = readError(connected ? vitals.error : null, "Vitals");
  const historyError = readError(
    connected ? sparkline.error : null,
    "CPU history"
  );
  const label = [
    host.display_name,
    platform.label,
    statusText,
    statusError,
    ...readings.map(({ label, value }) => `${label} ${value}`),
    chart?.ariaLabel,
    vitalsError,
    historyError,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      className="min-h-[44px] gap-2 rounded-xl border border-border bg-card p-3 active:opacity-70"
    >
      <HostRowHeader
        name={host.display_name}
        glyph={platform.path}
        tone={connection.tone}
        text={statusText}
        error={statusError}
      />
      <View className="flex-row flex-wrap gap-x-4 gap-y-2">
        {readings.map(({ label, value }) => (
          <View key={label} className="min-w-16 grow">
            <Text variant="caption">{label}</Text>
            {/** The NativeWind converter drops CSS font-variant-numeric. */}
            <Text variant="cardTitle" style={{ fontVariant: ["tabular-nums"] }}>
              {value}
            </Text>
          </View>
        ))}
      </View>
      {chart && <StreamArea {...chart} />}
      {vitalsError && (
        <Text variant="caption" className="text-destructive!">
          {vitalsError}
        </Text>
      )}
      {historyError && (
        <Text variant="caption" className="text-destructive!">
          {historyError}
        </Text>
      )}
    </Pressable>
  );
}

function readError(error: unknown, what: string) {
  return error === null
    ? null
    : `${what} unavailable. ${failureReason(error, "Pull down to reload.")}`;
}

function headlineReadings(vitals: HostVitals | undefined) {
  const { cpu_pct, memory_pct, net_rx_bps, net_tx_bps } = vitals ?? {};
  return [
    { label: "CPU", value: formatPercent(cpu_pct) },
    { label: "Memory", value: formatPercent(memory_pct) },
    {
      label: "Network",
      value: formatRate(
        net_rx_bps == null || net_tx_bps == null
          ? null
          : net_rx_bps + net_tx_bps
      ),
    },
  ];
}

function HostRowHeader({
  name,
  glyph,
  tone,
  text,
  error,
}: {
  name: string;
  glyph: string;
  tone: Tone;
  text: string;
  error: string | null;
}) {
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];
  return (
    <View className="flex-row items-start gap-2">
      <View className="mt-0.5">
        <Svg width={20} height={20} viewBox="0 0 20 20" accessible={false}>
          <Path
            d={glyph}
            stroke={colors["muted-foreground"]}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      </View>
      <View className="min-w-0 flex-1">
        <Text variant="cardTitle">{name}</Text>
        <View className="flex-row items-center gap-1.5">
          {tone === "live" && (
            <View className="size-1.5 rounded-full bg-live" />
          )}
          {tone === "warning" && <StatusWarning />}
          <Text
            variant="caption"
            className={
              tone === "warning" ? "shrink text-warning-ink" : "shrink"
            }
          >
            {text}
          </Text>
        </View>
        {error && (
          <Text variant="caption" className="text-destructive!">
            {error}
          </Text>
        )}
      </View>
    </View>
  );
}
