/**
 * The Monitoring tab's "Sampling" panel: Performance mode with what it
 * changes (D-088), the sample interval with StatGlass's measured overhead,
 * and the battery slow-down. History settings live in the History tab.
 */
import { formatPercent } from "@core/format";
import type { PerformanceReason, Settings } from "@core/generated/types";
import { slowestIntervalMs } from "@core/live-window";
import { performanceChanges, performanceNextLever } from "@core/performance";
import { INTERVALS_MS } from "@core/settings-patch";
import { SegmentedControl } from "~/components/segmented-control";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Switch } from "~/components/ui/switch";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { useHost } from "~/stores/host-store";
import { useSampling } from "~/stores/live-selectors";
import { useSettings } from "~/stores/settings-store";
import { intervalLabel, selfCpuAverage } from "../_lib/overhead";

const INTERVAL_OPTIONS = INTERVALS_MS.map((ms) => ({
  value: String(ms),
  label: intervalLabel(ms),
}));

const PERFORMANCE_CHANGES_ID = "settings-performance-changes";

/**
 * "Sampling": Performance mode, then the interval and battery slow-down
 * nested under it, since Performance mode overrides both.
 */
export function SamplingPanel({
  sampling,
}: {
  sampling: Settings["sampling"];
}) {
  const write = useWriteSettings();
  const { performance } = useSampling();
  const modules = useSettings((s) => s.modules) ?? {};
  const menuBar = useSettings((s) => s.menu_bar);
  const byLowPower = performance === "low_power_mode";
  const performanceOn = !!sampling.performance_mode || byLowPower;

  return (
    <SettingsPanel id="sampling" title="Sampling">
      <SettingsRow
        id="performance-mode"
        label="Performance mode"
        sub={
          byLowPower
            ? "On while Low Power Mode is on"
            : "Uses less CPU by updating less often and turning off animations"
        }
      >
        <Switch
          checked={performanceOn}
          disabled={byLowPower}
          aria-label="Performance mode"
          aria-describedby={PERFORMANCE_CHANGES_ID}
          onCheckedChange={(on) =>
            write({ sampling: { performance_mode: on } })
          }
        />
        <PerformanceChanges
          sampling={sampling}
          modules={modules}
          menuBar={menuBar}
          reason={performance}
        />
      </SettingsRow>
      <SampleIntervalRow sampling={sampling} />
      <SlowOnBatteryRow sampling={sampling} performanceOn={performanceOn} />
    </SettingsPanel>
  );
}

/** Slow down on battery: the slowest interval it backs off to; Performance mode forces it on. */
function SlowOnBatteryRow({
  sampling,
  performanceOn,
}: {
  sampling: Settings["sampling"];
  performanceOn: boolean;
}) {
  const write = useWriteSettings();
  return (
    <SettingsRow
      id="slow-on-battery"
      nested
      label="Slow down on battery"
      sub={performanceOn && "Set by Performance mode"}
    >
      <span className="font-normal text-muted-foreground text-small">
        to{" "}
        {intervalLabel(
          slowestIntervalMs({ ...sampling, slow_on_battery: true })
        )}
      </span>
      <Switch
        checked={sampling.slow_on_battery || performanceOn}
        disabled={performanceOn}
        aria-label="Slow down on battery"
        onCheckedChange={(on) => write({ sampling: { slow_on_battery: on } })}
      />
    </SettingsRow>
  );
}

/** The interval choice, with StatGlass's own CPU measured at the interval in effect. */
function SampleIntervalRow({ sampling }: { sampling: Settings["sampling"] }) {
  const write = useWriteSettings();
  // Measured, not a constant: `self.cpu` under the current sampling setup.
  const overhead = useHost(selfCpuAverage);
  // The interval in effect, which battery back-off can lengthen.
  const liveInterval =
    useHost((s) => s.status?.interval_ms) ?? sampling.interval_ms;

  return (
    <SettingsRow
      id="sample-interval"
      nested
      label="Sample interval"
      sub={
        overhead === "measuring" ? (
          `Measuring StatGlass's CPU at ${intervalLabel(liveInterval)}…`
        ) : overhead !== null ? (
          <>
            StatGlass uses about{" "}
            <span className="figures">
              {formatPercent(overhead, { decimals: 1 })}
            </span>{" "}
            CPU at {intervalLabel(liveInterval)}, this window included
          </>
        ) : null
      }
    >
      <SegmentedControl
        ariaLabel="Sample interval"
        options={INTERVAL_OPTIONS}
        value={String(sampling.interval_ms)}
        onChange={(v) => write({ sampling: { interval_ms: Number(v) } })}
      />
    </SettingsRow>
  );
}

/**
 * What Performance mode changes for this user, always shown so the cost reads
 * before the switch is turned on (D-088), then the next thing to change.
 */
function PerformanceChanges({
  sampling,
  modules,
  menuBar,
  reason,
}: {
  sampling: Settings["sampling"];
  modules: Settings["modules"];
  menuBar: Settings["menu_bar"] | null | undefined;
  reason: PerformanceReason;
}) {
  const changes = performanceChanges({ sampling, modules }, reason);
  const next = performanceNextLever({
    sampling,
    modules,
    ...(menuBar == null ? {} : { menu_bar: menuBar }),
  });
  return (
    <div
      id={PERFORMANCE_CHANGES_ID}
      className="-mt-2 basis-full pb-2.5 font-normal text-muted-foreground text-small"
    >
      <ul className="m-0 list-none p-0">
        {changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {next && <p className="m-0 mt-1.5">{next}</p>}
    </div>
  );
}
