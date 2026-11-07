import { ratio } from "@core/chart-math";
import { formatPercent } from "@core/format";
import { spanWords } from "@core/live-window";
import { useChartLabel } from "~/hooks/use-chart-label";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import { useReadFailure } from "~/hooks/use-read-failure";
import { useScaledWindow } from "~/hooks/use-scaled-window";
import {
  useBattery,
  usePowerSource,
  useSeriesWindow,
} from "~/stores/live-selectors";
import { MeterTrack } from "~/widgets/meter-track";
import { StreamArea } from "~/widgets/stream-area";

export function CompactBattery() {
  const battery = useBattery();
  const source = usePowerSource();
  const notice = useReadFailure("battery.charge");
  const status =
    source === "charging"
      ? "Charging"
      : source === "adapter"
        ? "On power"
        : source === "battery"
          ? "On battery"
          : "Power state unavailable";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="figures whitespace-nowrap">
          {formatPercent(battery.charge)} · {status}
        </span>
        <MeterTrack
          fraction={ratio(battery.charge, 100)}
          fill="var(--color-battery)"
          className="min-w-6 flex-1"
        />
      </div>
      {notice && (
        <span className="text-[11px] text-muted-foreground">{notice}</span>
      )}
    </div>
  );
}

export function CompactPower({ showBattery }: { showBattery: boolean }) {
  const windowMs = useScaledWindow(60_000);
  const history = useSeriesWindow("power.system", windowMs);
  const ceiling = useNiceCeiling(history.values, history.tEndMs, 1, windowMs);
  const ariaLabel = useChartLabel({
    subject: "System power",
    span: spanWords(windowMs, null),
  });
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-10 flex-1">
        <StreamArea
          series={[{ key: "power.system", values: history.values, step: 1 }]}
          tEndMs={history.tEndMs}
          intervalMs={history.intervalMs}
          yMax={ceiling}
          accent="power"
          height={14}
          ariaLabel={ariaLabel}
        />
      </div>
      {showBattery && <CompactBattery />}
    </div>
  );
}
