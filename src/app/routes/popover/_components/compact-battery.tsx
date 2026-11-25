import { spanWords } from "@core/live-window";
import { batteryCard } from "@core/popover/cards";
import { MINUTE_MS } from "@core/time-grid";
import { useChartLabel } from "~/hooks/use-chart-label";
import { useNiceCeiling } from "~/hooks/use-nice-ceiling";
import { useReadFailure } from "~/hooks/use-read-failure";
import { useShownRingLoading } from "~/hooks/use-ring";
import { useScaledWindow } from "~/hooks/use-scaled-window";
import {
  useBattery,
  usePowerSource,
  useSeriesWindow,
} from "~/stores/live-selectors";
import { MeterTrack } from "~/widgets/meter-track";
import { StreamArea } from "~/widgets/stream-area";

export function CompactBattery() {
  const card = batteryCard(useBattery(), { powerSource: usePowerSource() });
  const notice = useReadFailure("battery.charge");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-caption">
        <span className="figures whitespace-nowrap">
          {card.headline} · {card.status}
        </span>
        <MeterTrack
          fraction={card.chargeFraction}
          fill="var(--color-battery)"
          className="min-w-6 flex-1"
        />
      </div>
      {notice && (
        <span className="text-label text-muted-foreground">{notice}</span>
      )}
    </div>
  );
}

export function CompactPower({ showBattery }: { showBattery: boolean }) {
  const windowMs = useScaledWindow(MINUTE_MS);
  const history = useSeriesWindow("power.system", windowMs);
  const loading = useShownRingLoading(windowMs);
  const ceiling = useNiceCeiling(history.values, history.tEndMs, 1, windowMs);
  const ariaLabel = useChartLabel({
    subject: "System power",
    span: spanWords(windowMs, null),
  });
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-10 flex-1">
        <StreamArea
          loading={loading}
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
