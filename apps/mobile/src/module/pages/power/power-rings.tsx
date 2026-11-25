import {
  formatGhz,
  formatWatts,
  MISSING,
  rpmParts,
  type TemperatureUnits,
  temperatureParts,
  wattsParts,
} from "@core/format";
import type { HostId, PowerSource } from "@core/generated/types";
import { currentLayout, held, selectSensors } from "@core/live-selectors";
import { shallow } from "zustand/shallow";
import { useHostLive } from "@/data/live";
import { RingCard, RingCards } from "./ring-cards";
import { useWattRingCeiling } from "./watt-ring-ceiling";

const TEMP_MAX_C = 105;
const rpm = (value: number | null) =>
  value === null ? MISSING : rpmParts(value).value;

function fanSummary(fans: readonly (number | null)[]) {
  if (fans.length === 1) return `Fan ${rpm(fans[0] ?? null)}`;
  if (fans.length === 2)
    return `Left ${rpm(fans[0] ?? null)} · right ${rpm(fans[1] ?? null)}`;
  return fans.map((value, index) => `${index + 1}: ${rpm(value)}`).join(" · ");
}

function fanDetail(
  fans: readonly (number | null)[],
  mode: number | null,
  hasMode: boolean
) {
  const speed = fanSummary(fans);
  if (mode === 0) return `${speed} · Automatic`;
  if (mode === 1) return `${speed} · Manual`;
  return hasMode ? `${speed} · Mode ${MISSING}` : speed;
}

function systemDetail(
  source: PowerSource | null,
  packageW: number | null,
  hasPackage: boolean
) {
  const label =
    source === "battery"
      ? "Drawn from battery"
      : source === "adapter" || source === "charging"
        ? "From power adapter"
        : "Power source unknown";
  return hasPackage ? `${label} · Package ${formatWatts(packageW)}` : label;
}

export function PowerRings({
  host,
  live,
  units,
  pFreqKey,
  source,
  systemW,
  hasPower,
  showPassiveCooling,
}: {
  host: HostId;
  live: boolean;
  units: TemperatureUnits;
  pFreqKey: string;
  source: PowerSource | null;
  systemW: number | null;
  hasPower: boolean;
  showPassiveCooling: boolean;
}) {
  const layout = useHostLive(host, currentLayout);
  const [cpu, gpu, fanRpm, fanMax, gpuFreq, pFreq, fanMode, packageW, ...fans] =
    useHostLive(
      host,
      (s) => {
        const { cpu, gpu, fanRpm, fanMax } = selectSensors(s);
        const fanKeys = layout?.byMetric.get("fan.rpm") ?? [];
        return [
          cpu,
          gpu,
          fanRpm,
          fanMax,
          held(s, "gpu.freq"),
          held(s, pFreqKey),
          held(s, "fan.mode"),
          held(s, "power.package"),
          ...fanKeys.map((key) => held(s, key)),
        ].map((value) => (live ? value : null));
      },
      shallow
    );
  const ceiling = useWattRingCeiling(
    host,
    "power.system",
    live && hasPower,
    systemW,
    40
  );
  if (!layout) return null;

  const temperature = (name: string, value: number | null) => ({
    label: `${name} temperature (°${units})`,
    accent: "temp" as const,
    value,
    max: TEMP_MAX_C,
    format: (c: number) => temperatureParts(c, { units }).value,
  });
  const available = layout.byMetric;
  return (
    <RingCards>
      {available.has("thermal.cpu") && (
        <RingCard
          accent="power"
          title="CPU"
          unit={`°${units}`}
          ring={temperature("CPU", cpu ?? null)}
          detail={`P-cluster · ${formatGhz(pFreq)}`}
        />
      )}
      {available.has("thermal.gpu") && (
        <RingCard
          accent="power"
          title="GPU"
          unit={`°${units}`}
          ring={temperature("GPU", gpu ?? null)}
          detail={`Frequency · ${formatGhz(gpuFreq)}`}
        />
      )}
      {available.has("fan.rpm") ? (
        <RingCard
          accent="power"
          title="Fans"
          unit="RPM"
          ring={{
            label: "Fan speed (RPM)",
            value: fanRpm ?? null,
            max: fanMax ?? 0,
            format: rpm,
          }}
          detail={fanDetail(fans, fanMode ?? null, available.has("fan.mode"))}
        />
      ) : (
        showPassiveCooling && (
          <RingCard accent="power" title="Fans" detail="Passive cooling" />
        )
      )}
      {hasPower && available.has("power.system") && (
        <RingCard
          accent="power"
          title="System"
          unit="W"
          ring={{
            label: "System draw (W)",
            value: systemW,
            max: ceiling,
            format: (value) => wattsParts(value).value,
          }}
          detail={systemDetail(
            source,
            packageW ?? null,
            available.has("power.package")
          )}
        />
      )}
    </RingCards>
  );
}
