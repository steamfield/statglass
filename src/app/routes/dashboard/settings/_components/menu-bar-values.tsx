/**
 * The Menu bar panel's values block: one switch per readout printed after
 * the bars, each with its marker and the value it would print now.
 */
import type { MenuBarSettings, Readout } from "@core/generated/types";
import { READOUTS } from "@core/generated/types";
import type { SettingsModule } from "@core/settings-patch";
import { readoutPatch } from "@core/settings-patch";
import {
  pctText,
  rateLine,
  readoutModule,
  type TrayMarker,
  type TrayReadings,
  type TrayUnits,
  tempText,
  wattsText,
} from "@core/tray-layout";
import type { ReactNode } from "react";
import { Switch } from "~/components/ui/switch";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { cn } from "~/lib/utils";
import { FIELD_LABEL } from "~/widgets/lib/classes";
import { TrayMarkerIcon } from "~/widgets/tray-preview";

const READOUT_ROWS: Record<
  Readout,
  { name: string; spoken: string; marker: TrayMarker }
> = {
  cpu: { name: "CPU", spoken: "CPU", marker: { kind: "label", text: "CPU" } },
  gpu: { name: "GPU", spoken: "GPU", marker: { kind: "label", text: "GPU" } },
  memory: {
    name: "Memory",
    spoken: "memory",
    marker: { kind: "label", text: "MEM" },
  },
  temperature: {
    name: "Hottest temperature",
    spoken: "the hottest temperature",
    marker: { kind: "none" },
  },
  power: {
    name: "Power",
    spoken: "power",
    marker: { kind: "glyph", glyph: "bolt" },
  },
  network: {
    name: "Network",
    spoken: "network rates",
    marker: { kind: "none" },
  },
  disk: {
    name: "Disk used",
    spoken: "disk used",
    marker: { kind: "glyph", glyph: "drive" },
  },
  battery: {
    name: "Battery",
    spoken: "battery",
    marker: { kind: "label", text: "BAT" },
  },
};

// No `last:` border rule: these rows sit inside a wrapper, not the panel.
const ROW =
  "flex min-h-10 items-center gap-3 border-border-subtle border-b px-4 text-body";

/** What the readout prints now, as the menu bar formats it. */
function readoutValue(r: Readout, v: TrayReadings, units: TrayUnits): string {
  switch (r) {
    case "cpu":
      return pctText(v.cpu);
    case "gpu":
      return pctText(v.gpu);
    case "memory":
      return pctText(v.mem);
    case "temperature":
      return tempText(v.temp, units.temperature);
    case "power":
      return wattsText(v.power);
    case "network":
      return `↑ ${rateLine(v.netUp, units.network)}  ↓ ${rateLine(v.netDown, units.network)}`;
    case "disk":
      return pctText(v.diskUsed);
    case "battery":
      return pctText(v.battery);
  }
}

/** The marker column: the readout's marker as the menu bar draws it, muted. */
function MarkerCell({ readout }: { readout: Readout }) {
  const { marker } = READOUT_ROWS[readout];
  return (
    <span
      aria-hidden
      className="flex w-5 shrink-0 items-center justify-center text-muted-foreground"
    >
      {readout === "network" ? (
        <span className="font-tray text-label">↑↓</span>
      ) : readout === "temperature" ? (
        <span className="font-tray text-label">°</span>
      ) : (
        <TrayMarkerIcon marker={marker} />
      )}
    </span>
  );
}

/** One readout's row: marker, name, why it is off, its value now, the switch. */
function ReadoutRow({
  readout,
  shown,
  off,
  locked,
  value,
}: {
  readout: Readout;
  shown: boolean;
  off: ReactNode;
  locked: boolean;
  value: string;
}) {
  const write = useWriteSettings();
  const row = READOUT_ROWS[readout];
  const id = `settings-readout-${readout}`;
  return (
    <div className={ROW}>
      <MarkerCell readout={readout} />
      <div className="flex min-w-0 flex-1 flex-col py-2">
        <label htmlFor={id} className={cn(off && "text-muted-foreground")}>
          {row.name}
        </label>
        {off && (
          <span className="font-normal text-muted-foreground text-small">
            {off}
          </span>
        )}
      </div>
      {!off && (
        <span className="figures whitespace-pre text-muted-foreground text-small">
          {value}
        </span>
      )}
      <Switch
        id={id}
        checked={!off && shown}
        disabled={locked || Boolean(off)}
        aria-label={`Show ${row.spoken} in the menu bar`}
        onCheckedChange={(on) => write(readoutPatch(readout, on))}
      />
    </div>
  );
}

/**
 * "Values after the bars": the field label and a row per readout. `offReason`
 * says why a module's readout is disabled; `locked` disables them all.
 */
export function MenuBarValues({
  readouts,
  offReason,
  locked,
  readings,
  units,
}: {
  readouts: MenuBarSettings["readouts"];
  offReason: (m: SettingsModule) => ReactNode;
  locked: boolean;
  readings: TrayReadings;
  units: TrayUnits;
}) {
  return (
    <div data-settings-row="menu-bar-values">
      <div className={cn(FIELD_LABEL, "px-4 pt-3 pb-1")}>
        Values after the bars
      </div>
      {READOUTS.map((r) => (
        <ReadoutRow
          key={r}
          readout={r}
          shown={readouts[r]}
          off={offReason(readoutModule(r))}
          locked={locked}
          value={readoutValue(r, readings, units)}
        />
      ))}
    </div>
  );
}
