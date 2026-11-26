/**
 * The Units panel on the General tab: temperature, network rate and memory
 * units, each with a live example in the selected unit.
 */
import { formatBytes, formatRate, formatTemperature } from "@core/format";
import type {
  MemoryUnit,
  NetworkUnit,
  Settings,
  TemperatureUnit,
} from "@core/generated/types";
import { SegmentedControl } from "~/components/segmented-control";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { useWriteSettings } from "~/hooks/use-write-settings";

const TEMPERATURE = [
  { value: "celsius", label: "°C" },
  { value: "fahrenheit", label: "°F" },
] as const satisfies readonly { value: TemperatureUnit; label: string }[];
const NETWORK = [
  { value: "bytes_per_sec", label: "MB/s" },
  { value: "bits_per_sec", label: "Mb/s" },
] as const satisfies readonly { value: NetworkUnit; label: string }[];
const MEMORY = [
  { value: "decimal", label: "GB" },
  { value: "binary", label: "GiB" },
] as const satisfies readonly { value: MemoryUnit; label: string }[];

const EXAMPLE_CELSIUS = 52;
const EXAMPLE_BYTES_PER_SECOND = 3.2e6;
const EXAMPLE_BYTES = 36e9;

/** The sub line under a unit row: "Shows as 52 °C". */
function showsAs(example: string): string {
  return `Shows as ${example}`;
}

/** "Units" settings panel: how temperatures, network rates and memory read. */
export function UnitsPanel({ units }: { units: Settings["units"] }) {
  const write = useWriteSettings();
  return (
    <SettingsPanel id="units" title="Units">
      <SettingsRow
        id="temperature-unit"
        label="Temperature"
        sub={showsAs(
          formatTemperature(EXAMPLE_CELSIUS, {
            units: units.temperature === "fahrenheit" ? "F" : "C",
          })
        )}
      >
        <SegmentedControl
          ariaLabel="Temperature unit"
          options={TEMPERATURE}
          value={units.temperature}
          onChange={(temperature) => write({ units: { temperature } })}
        />
      </SettingsRow>
      <SettingsRow
        id="network-unit"
        label="Network rate"
        sub={showsAs(
          formatRate(EXAMPLE_BYTES_PER_SECOND, {
            units: units.network === "bits_per_sec" ? "Mbps" : "MBps",
          })
        )}
      >
        <SegmentedControl
          ariaLabel="Network unit"
          options={NETWORK}
          value={units.network}
          onChange={(network) => write({ units: { network } })}
        />
      </SettingsRow>
      <SettingsRow
        id="memory-unit"
        label="Memory"
        sub={showsAs(
          formatBytes(EXAMPLE_BYTES, {
            units: units.memory === "binary" ? "GiB" : "GB",
          })
        )}
      >
        <SegmentedControl
          ariaLabel="Memory base"
          options={MEMORY}
          value={units.memory}
          onChange={(memory) => write({ units: { memory } })}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}
